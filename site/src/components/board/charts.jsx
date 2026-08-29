import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { compact, dayLabel, full, niceMax, SERIES, shortModel, useWidth, usd } from './util'

/* ── tooltip: one floating layer for every chart ────────────────────── */

const TipCtx = createContext({ show: () => {}, hide: () => {} })
export const useTip = () => useContext(TipCtx)

export function TipProvider({ children }) {
  const [tip, setTip] = useState(null)
  const boxRef = useRef(null)

  const show = useCallback((evt, title, rows) => {
    setTip({ x: evt.clientX, y: evt.clientY, title, rows })
  }, [])
  const hide = useCallback(() => setTip(null), [])

  useEffect(() => {
    const h = () => setTip(null)
    addEventListener('scroll', h, true)
    return () => removeEventListener('scroll', h, true)
  }, [])

  /* Clamp to the viewport once the box has a size. */
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !tip) return
    const pad = 14, w = box.offsetWidth, h = box.offsetHeight
    let x = tip.x + pad, y = tip.y + pad
    if (x + w > innerWidth - 8) x = tip.x - w - pad
    if (y + h > innerHeight - 8) y = tip.y - h - pad
    box.style.left = Math.max(8, x) + 'px'
    box.style.top = Math.max(8, y) + 'px'
  }, [tip])

  return (
    <TipCtx.Provider value={{ show, hide }}>
      {children}
      <div className="bv-tip" ref={boxRef} style={{ opacity: tip ? 1 : 0 }} role="status" aria-live="polite">
        {tip && (
          <>
            <div className="t">{tip.title}</div>
            {tip.rows.map((r, i) => (
              <div className="r" key={i}>
                <span className="l">
                  {r.color && <span className="sw" style={{ background: r.color }} />}
                  <span>{r.label}</span>
                </span>
                <span className="n">{r.value}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </TipCtx.Provider>
  )
}

/* ── shared scaffolding ─────────────────────────────────────────────── */

const M = { t: 10, r: 8, b: 22, l: 42 }

function YAxis({ w, h, max, ticks = 4, fmt = compact }) {
  const ih = h - M.t - M.b
  const rows = []
  for (let i = 0; i <= ticks; i++) {
    const v = max * i / ticks
    const y = M.t + ih - (ih * i / ticks)
    rows.push(
      <g key={i}>
        <line className="grid-line" x1={M.l} x2={w - M.r} y1={y} y2={y} />
        <text x={M.l - 7} y={y + 3} textAnchor="end">{fmt(v)}</text>
      </g>,
    )
  }
  return <>{rows}</>
}

function XLabels({ w, h, items, label }) {
  const iw = w - M.l - M.r
  const step = Math.max(1, Math.ceil(items.length / Math.max(3, Math.floor(iw / 62))))
  return (
    <>
      {items.map((d, i) => {
        if (i % step && i !== items.length - 1) return null
        const x = M.l + (items.length === 1 ? iw / 2 : iw * i / (items.length - 1))
        return <text key={i} x={x} y={h - 6} textAnchor="middle">{label(d, i)}</text>
      })}
    </>
  )
}

const Axis = ({ w, h }) => (
  <line className="axis" x1={M.l} x2={w - M.r} y1={h - M.b} y2={h - M.b} />
)

/* ── daily activity: two comparable counts, one axis ────────────────── */

export function ActivityChart({ daily }) {
  const [ref, w] = useWidth()
  const { show, hide } = useTip()
  const [hover, setHover] = useState(null)
  const h = 200

  const defs = [
    { key: 'messages', label: 'Messages', color: SERIES[0] },
    { key: 'toolCalls', label: 'Tool calls', color: SERIES[1] },
  ]

  if (!daily.length) {
    return <div ref={ref}><svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%"><text x={M.l} y={40}>no data</text></svg></div>
  }

  const max = niceMax(Math.max(1, ...daily.flatMap(d => defs.map(s => d[s.key]))))
  const iw = w - M.l - M.r, ih = h - M.t - M.b
  const X = i => M.l + (daily.length === 1 ? iw / 2 : iw * i / (daily.length - 1))
  const Y = v => M.t + ih - (ih * v / max)

  const move = e => {
    const box = e.currentTarget.ownerSVGElement.getBoundingClientRect()
    const px = (e.clientX - box.left) * (w / box.width)
    const i = Math.max(0, Math.min(daily.length - 1, Math.round((px - M.l) / (iw / Math.max(1, daily.length - 1)))))
    setHover(i)
    const row = daily[i]
    show(e, row.date, defs.map(s => ({ color: s.color, label: s.label, value: full(row[s.key]) })))
  }
  const leave = () => { setHover(null); hide() }

  const totals = defs.map(s => daily.reduce((a, r) => a + r[s.key], 0))

  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%" role="img" aria-label="Messages and tool calls per day">
        <YAxis w={w} h={h} max={max} />
        <Axis w={w} h={h} />
        {hover != null && <line className="crosshair" x1={X(hover)} x2={X(hover)} y1={M.t} y2={M.t + ih} style={{ opacity: 1 }} />}
        {defs.map(s => (
          <path key={s.key} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
            d={daily.map((row, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(row[s.key]).toFixed(1)}`).join(' ')} />
        ))}
        {hover != null && defs.map(s => (
          <circle key={s.key} r="4" fill={s.color} className="dot-ring" cx={X(hover)} cy={Y(daily[hover][s.key])} />
        ))}
        <rect className="hit" x={M.l} y={M.t} width={iw} height={ih} onMouseMove={move} onMouseLeave={leave} />
        <XLabels w={w} h={h} items={daily} label={d => dayLabel(d.date)} />
      </svg>
      <Legend items={defs.map((s, i) => ({ color: s.color, label: s.label, value: compact(totals[i]) + ' total' }))} />
    </div>
  )
}

/* ── stacked bars, used by the token and spend charts ───────────────── */

export function StackedBarChart({ rows, names, colors, height = 200, yFmt = compact, tipValue = full, totalLabel = 'total', ariaLabel }) {
  const [ref, w] = useWidth()
  const { show, hide } = useTip()
  const h = height

  if (!rows.length || !names.length) {
    return <div ref={ref}><svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%"><text x={M.l} y={40}>no data yet</text></svg></div>
  }

  const max = niceMax(Math.max(0.01, ...rows.map(r => r.total || 0)))
  const iw = w - M.l - M.r, ih = h - M.t - M.b
  const bw = Math.max(2, Math.min(18, iw / rows.length - 2))

  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%" role="img" aria-label={ariaLabel}>
        <YAxis w={w} h={h} max={max} fmt={yFmt} />
        <Axis w={w} h={h} />
        {rows.map((r, i) => {
          const x = M.l + (rows.length === 1 ? iw / 2 - bw / 2 : (iw - bw) * i / (rows.length - 1))
          let acc = 0
          const segs = []
          names.forEach(n => {
            const v = Number((r.by || {})[n]) || 0
            if (v <= 0) return
            const y0 = M.t + ih - ih * (acc + v) / max
            const y1 = M.t + ih - ih * acc / max
            segs.push(<rect key={n} x={x} y={y0} width={bw} height={Math.max(1, y1 - y0 - 2)} rx="2" fill={colors[n]} />)
            acc += v
          })
          return (
            <g key={r.date}>
              {segs}
              <rect className="hit" x={x - 1} y={M.t} width={bw + 2} height={ih}
                onMouseMove={e => show(e, r.date,
                  names.filter(n => (r.by || {})[n]).map(n => ({ color: colors[n], label: shortModel(n), value: tipValue(r.by[n]) }))
                    .concat([{ label: totalLabel, value: tipValue(r.total) }]))}
                onMouseLeave={hide} />
            </g>
          )
        })}
        <XLabels w={w} h={h} items={rows} label={r => dayLabel(r.date)} />
      </svg>
    </div>
  )
}

/* ── hour histogram: one series, no legend - the title names it ─────── */

export function HourChart({ hours }) {
  const [ref, w] = useWidth()
  const { show, hide } = useTip()
  const h = 150
  const vals = Array.from({ length: 24 }, (_, i) => Number(hours[String(i)]) || 0)
  const max = niceMax(Math.max(1, ...vals))
  const iw = w - M.l - M.r, ih = h - M.t - M.b
  const bw = Math.max(3, iw / 24 - 3)
  const c = SERIES[0]

  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%" role="img" aria-label="Sessions by hour of day">
        <YAxis w={w} h={h} max={max} ticks={2} />
        <Axis w={w} h={h} />
        {vals.map((v, i) => {
          const x = M.l + (iw / 24) * i + 1.5
          const hgt = v ? Math.max(2, ih * v / max) : 0
          return (
            <g key={i}>
              {hgt > 0 && <rect x={x} y={M.t + ih - hgt} width={bw} height={hgt} rx="2" fill={c} />}
              <rect className="hit" x={x - 1.5} y={M.t} width={iw / 24} height={ih}
                onMouseMove={e => show(e, `${String(i).padStart(2, '0')}:00`, [{ color: c, label: 'sessions', value: full(v) }])}
                onMouseLeave={hide} />
            </g>
          )
        })}
        {[0, 6, 12, 18, 23].map(i => (
          <text key={i} x={M.l + (iw / 24) * i + bw / 2} y={h - 6} textAnchor="middle">{String(i).padStart(2, '0')}</text>
        ))}
      </svg>
    </div>
  )
}

/* ── Codex tokens per day: a single bar and a note saying what it means ── */

export function CodexDayChart({ rows }) {
  const [ref, w] = useWidth()
  const { show, hide } = useTip()
  const h = 200
  rows = (rows || []).slice(-45)

  if (!rows.length) {
    return <div ref={ref}><svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%"><text x={12} y={26}>No day has any tokens on it yet.</text></svg></div>
  }

  const max = niceMax(Math.max(1, ...rows.map(r => r.tokens || 0)))
  const iw = w - M.l - M.r, ih = h - M.t - M.b
  const step = iw / rows.length, bw = Math.max(2, step - 3)
  const c = SERIES[1]

  return (
    <div ref={ref}>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} height={h} width="100%" role="img" aria-label="Codex tokens per day">
        <YAxis w={w} h={h} max={max} ticks={2} />
        <Axis w={w} h={h} />
        {rows.map((r, i) => {
          const x = M.l + step * i + 1.5
          const v = r.tokens || 0
          const hgt = v ? Math.max(2, ih * v / max) : 0
          return (
            <g key={r.date}>
              {hgt > 0 && <rect x={x} y={M.t + ih - hgt} width={bw} height={hgt} rx="2" fill={c} />}
              <rect className="hit" x={x - 1.5} y={M.t} width={step} height={ih}
                onMouseMove={e => show(e, r.date, [
                  { color: c, label: 'tokens', value: full(v) },
                  { label: 'output', value: full(r.output || 0) },
                  { label: 'sessions', value: full(r.sessions || 0) },
                ])}
                onMouseLeave={hide} />
            </g>
          )
        })}
        <XLabels w={w} h={h} items={rows} label={r => dayLabel(r.date)} />
      </svg>
    </div>
  )
}

/* ── legend ─────────────────────────────────────────────────────────── */

export function Legend({ items }) {
  if (!items.length) return null
  return (
    <ul className="bv-legend">
      {items.map((it, i) => (
        <li key={i}>
          <span className="sw" style={{ background: it.color }} />
          <span>{it.label}</span>
          <span className="val">{it.value}</span>
        </li>
      ))}
    </ul>
  )
}

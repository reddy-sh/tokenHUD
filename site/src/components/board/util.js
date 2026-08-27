import { useEffect, useRef, useState } from 'react'

/* ── formatters, ported from the classic board ──────────────────────── */

/* Numbers people read: 4,471,522,009 is noise; 4.47B is the fact. */
export function compact(n) {
  n = Number(n) || 0
  const a = Math.abs(n)
  if (a >= 1e12) return (n / 1e12).toFixed(a >= 1e13 ? 0 : 1) + 'T'
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B'
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
  return String(n)
}

export const full = n => (Number(n) || 0).toLocaleString('en-US')

/* Dollars: two decimals only while they still mean something. */
export function usd(n) {
  n = Number(n) || 0
  const dp = Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 3
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

export const usdShort = n => '$' + compact(Math.round(Number(n) || 0))

export const shortModel = m => String(m).replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const dayLabel = d => { const p = String(d).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : d }

export function ago(iso) {
  if (!iso) return '-'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (!isFinite(s)) return '-'
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

export function until(iso) {
  const ms = new Date(iso).getTime() - Date.now()
  if (!isFinite(ms)) return null
  return Math.round(ms / 1000)
}

/* Coarse on purpose. Nobody schedules their afternoon on the seconds column. */
export function dur(secs) {
  if (secs == null) return '-'
  if (secs <= 0) return 'now'
  const d = Math.floor(secs / 86400), h = Math.floor(secs % 86400 / 3600), m = Math.floor(secs % 3600 / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m) return `${m}m`
  return `${secs}s`
}

export function clock(iso) {
  const t = new Date(iso)
  if (!isFinite(t.getTime())) return ''
  const sameDay = t.toDateString() === new Date().toDateString()
  return sameDay ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : t.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export function windowLabel(mins) {
  if (!mins) return ''
  if (mins % 1440 === 0) return (mins / 1440) + '-day'
  if (mins % 60 === 0) return (mins / 60) + 'h'
  return mins + 'm'
}

/* The same arithmetic pricing.py does, applied in the browser. */
export function estimateRow(card, row) {
  const rate = (card.rates || []).find(r => r.model === shortModel(row.model)
    || r.model === row.model
    || shortModel(r.model) === shortModel(row.model))
  if (!rate) return null
  const per = 1e6
  return (row.input || 0) * rate.input / per
    + (row.output || 0) * rate.output / per
    + (row.cacheRead || 0) * rate.input * (card.cacheRead ?? 0.1) / per
    + (row.cacheCreate || 0) * rate.input * (card.cacheWrite5m ?? 1.25) / per
}

export function niceMax(v) {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  return Math.ceil(v / p * 2) / 2 * p
}

/* ── palette (the site is dark-only, so these are constants) ────────── */

export const SERIES = [
  'oklch(74% 0.18 55)',   /* amber - the site accent */
  'oklch(70% 0.14 230)',  /* blue */
  'oklch(74% 0.16 145)',  /* green */
  'oklch(68% 0.20 18)',   /* red-pink */
  'oklch(72% 0.15 300)',  /* violet */
]
export const WARNING = 'oklch(80% 0.15 85)'
export const CRITICAL = 'oklch(70% 0.22 25)'
export const OK = 'oklch(74% 0.16 145)'

export function severityColor(s) {
  if (s === 'critical') return CRITICAL
  if (s === 'warning' || s === 'serious') return WARNING
  return SERIES[0]
}

/* ── hooks ──────────────────────────────────────────────────────────── */

/* One shared ticker for every countdown on the board. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/* Charts measure their container when they draw; a resize or the rail
   sliding changes it with no data moving. */
export function useWidth(fallback = 600) {
  const ref = useRef(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const width = node.clientWidth
      if (width) setW(width)
    })
    ro.observe(node)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

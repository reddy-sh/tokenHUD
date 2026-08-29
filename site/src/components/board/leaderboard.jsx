import { useMemo, useState } from 'react'
import {
  composition, GROUPINGS, groupingOf, METRICS, MIN_PUBLIC_ENTRANTS, PERIODS,
  rankBoard, rankGroups, TIERS, UNIT_ACCOUNT, unitOf,
} from '../../lib/leaderboard'
import { boardTotals, costBasisOf, freshness, NO_ENTRIES } from '../../lib/demand'
import { Card, Empty, Pill } from './panels'
import { ago, clock, compact, full, SERIES, shortModel, usd } from './util'

/* The ranking - one component, two units, and the difference between them is
 * the whole of this file's design.
 *
 * ANALYTICS is your own machines, side by side. You own all of them, so there
 * is no contest: the useful question is which of your machines does the work
 * and how that has moved, and the answer is a plain ordered table. Medals here
 * would be a laptop beating a desktop that you also own, and a "#1 of 3" badge
 * would be a rank in a field of one person.
 *
 * A LEADERBOARD is accounts that opted in, against each other. That is a
 * competition, so it gets what a competition gets - a podium, medals, tiers -
 * and, because a competition needs a field, it publishes nothing at all until
 * MIN_PUBLIC_ENTRANTS accounts are in. A podium of one is not a small
 * leaderboard; it is a different thing wearing a leaderboard's clothes.
 *
 * The unit comes from the entries themselves (`unitOf`) so that no caller can
 * get it wrong by forgetting a prop, and a caller that knows better can still
 * say so outright. */

const fmt = (metric, v) => (v == null ? '-' : metric.unit === 'usd' ? usd(v) : compact(v))

/* ── a dollar figure, with the claim it rests on ────────────────────────
 *
 * A cost is a number and an argument about how it was arrived at, and rendered
 * apart from that argument "$0" covers free, no-rate-card-for-this-model, and
 * included-in-a-flat-subscription - three different facts that a reader has no
 * way to tell apart. `costBasis` travels with the figure all the way from the
 * agent (agent/src/pricing.rs) through shared/profile.mjs, so this is the cell
 * that finally spends it.
 *
 * It lived on the Models page, where it was written for the Assistants table.
 * It is here now because four surfaces print money and one of them printing it
 * differently is exactly the drift this was written to prevent.
 */

const BASIS_NOTE = {
  list_price: "Tokens counted here, priced at the provider's published list rates. An estimate, not a bill.",
  unpriced: 'Counted, but this build has no rate card for these models. Not zero - unpriced.',
  not_metered: 'A flat subscription: there is no per-request price to report.',
  credits: 'This provider meters in its own unit, not dollars. Reported in that unit.',
  api_equivalent: 'What the same work would have cost through the API. The plan it actually ran on was billed differently.',
  mixed: 'Summed across sources with different cost bases, so the total is not one kind of number.',
}

const BASIS_LABEL = {
  credits: 'in credits',
  not_metered: 'not metered',
  mixed: 'mixed basis',
  unpriced: 'not priced',
}

/* `row` is anything carrying `{ estUSD, priced, costBasis }` - a tool, a model,
   a grouped row, or a whole board's totals. */
export function Cost({ row }) {
  const basis = row?.costBasis
  if (row?.priced && row?.estUSD != null) {
    return <span title={BASIS_NOTE[basis] || BASIS_NOTE.list_price}>{usd(row.estUSD)}</span>
  }
  return (
    <span className="lb-unpriced" title={BASIS_NOTE[basis] || BASIS_NOTE.unpriced}>
      {BASIS_LABEL[basis] || BASIS_LABEL.unpriced}
    </span>
  )
}

/* One entry's value, with the basis its own tools reported.
 *
 * `totals.estUSD` is a plain number even on a machine nothing here can price,
 * because the sum of no dollars is zero - so the number alone cannot tell a
 * Codex-only machine (nothing priced) from a quiet week (genuinely nothing
 * spent). The basis can, and it is the only thing that can. */
function entryCost(entry, value) {
  const basis = costBasisOf([entry])
  return { estUSD: value, priced: basis != null && basis !== 'unpriced', costBasis: basis }
}

/* ── token composition ──────────────────────────────────────────────────
 *
 * Never a bare total. The reasoning is in shared/ranking.mjs beside the
 * arithmetic; what it means here is that wherever a headline token figure
 * appears, its five parts appear with it, because two fleets with the same
 * total and different compositions are not comparable and the total alone
 * cannot say so.
 *
 * The residual gets a band and not a hue. "We could not attribute this" must
 * not be able to look like a part.
 */

const PART_TONE = { input: SERIES[1], cacheRead: SERIES[2], cacheWrite: SERIES[4], output: SERIES[0], reasoning: SERIES[3] }

export function Composition({ totals, note = true }) {
  const c = composition(totals)
  if (!c.total) return null
  const shown = c.parts.filter(p => p.value)

  return (
    <div>
      {/* Flex rather than five stacked fills: `.lb-bar .fill` is drawn as one
          bar and five of them would sit on top of each other. */}
      <div className="lb-bar" style={{ display: 'flex', height: '10px' }}>
        {shown.map(p => (
          <span key={p.key} title={`${p.label}: ${full(p.value)} (${Math.round(p.pct)}%)`}
            style={{ width: p.pct + '%', background: PART_TONE[p.key] }} />
        ))}
        {c.residual > 0 && (
          <span title={`Reported without a split: ${full(c.residual)}`}
            style={{ width: c.residualPct + '%', background: 'var(--color-rule-strong)' }} />
        )}
      </div>
      <ul className="bv-legend">
        {c.parts.map(p => (
          <li key={p.key} title={p.note}>
            <span className="sw" style={{ background: PART_TONE[p.key], opacity: p.value == null ? 0.25 : 1 }} />
            <span>{p.label}</span>
            <span className="val">
              {/* A part nobody reports is "not reported", never 0 - a fleet
                  that did no thinking and a build that does not count thinking
                  are different findings. */}
              {p.value == null ? 'not reported' : compact(p.value)}
            </span>
          </li>
        ))}
        {c.residual > 0 && (
          <li title="A tool reported these tokens without saying which part they were.">
            <span className="sw" style={{ background: 'var(--color-rule-strong)' }} />
            <span>unsplit</span>
            <span className="val">{compact(c.residual)}</span>
          </li>
        )}
      </ul>
      {note && (
        <p className="bv-note">
          <b>{full(c.total)}</b> tokens, each counted once. Codex reports a headline total
          that is mostly cached input; Claude Code&rsquo;s own chart leaves cache reads out
          altogether. Neither headline is comparable to the other, so this board shows the
          parts and defines the total as their sum.
          {c.overlap > 0 && (
            <> Codex counts cached input inside its input figure and reasoning inside its
              output figure, so {compact(c.overlap)} tokens appear in two parts at once
              here - the bands are drawn from the parts, and the headline that tool
              publishes is {compact(c.reported)}.</>
          )}
        </p>
      )}
    </div>
  )
}

/* ── methodology ────────────────────────────────────────────────────────
 *
 * Four questions, in the order a sceptical reader asks them: what is this
 * number, who is in it, how old is it, and what does it NOT prove. The last
 * one is the one everybody leaves out, and it is the one that decides whether
 * a board is evidence or decoration.
 */

export function Methodology({ entries, pricingAsOf, windowDays, unit }) {
  const list = entries || NO_ENTRIES
  const totals = boardTotals(list)
  const fresh = freshness(list)
  const account = (unit || unitOf(list)) === UNIT_ACCOUNT

  return (
    <Card title="How these numbers were made"
      note="Every figure on this page rests on the four answers below. If one of them is not true for what you are about to conclude, the number is not evidence for it.">
      <div className="bv-stack">
        <p className="bv-note">
          <b>What is measured.</b>{' '}
          Tokens the local AI coding tools already wrote to disk, read by an agent on each
          machine and reported as counts. Tokens are shown as their composition - fresh
          input, cache reads, cache writes, output and reasoning - because a single
          &ldquo;total&rdquo; means a different thing in each tool.{' '}
          <b>Value is an estimate, not a bill</b>: it prices those tokens at the provider&rsquo;s
          published API list rates
          {pricingAsOf ? <> as of {pricingAsOf}</> : null}, and almost all of this work
          actually ran on flat-rate plans. The estimate carries the basis it was arrived at
          - list price, unpriced, credits, or mixed - and a figure with no rate card behind
          it reads &ldquo;not priced&rdquo; rather than $0.
          {totals.costBasis && totals.costBasis !== 'list_price' && (
            <> On this board that basis is <b>{totals.costBasis.replace('_', ' ')}</b>.</>
          )}
        </p>

        <p className="bv-note">
          <b>Who is in it.</b>{' '}
          {account
            ? <>Only accounts that opted in. Nobody is listed for having installed the agent;
              an account appears when its owner chose a handle and turned the public board
              on, and disappears when they turn it off. The ranking is over{' '}
              {list.length} account{list.length === 1 ? '' : 's'} - not over everyone who
              runs this tool, and not a sample of anything.</>
            : <>Every machine reporting to this board - {list.length} of them, all belonging
              to the same account. This is your own fleet compared against itself, so it is
              a complete census of your machines and evidence about nobody else&rsquo;s.</>}
          {' '}Machines that have gone quiet keep their last known numbers rather than
          dropping out, because a fleet that shrank when somebody closed a laptop would
          make every trend line a lie.
        </p>

        <p className="bv-note">
          <b>How fresh.</b>{' '}
          {fresh.through
            ? <>Complete through <b>{fresh.through}</b> - the newest daily bucket that can
              no longer change. That stamp is not the time this page was drawn: today&rsquo;s
              bucket is still filling, and comparing a part-day against whole ones is how a
              fleet appears to fall off a cliff every morning.</>
            : <>No complete day yet. Every bucket on this board is still filling, so nothing
              here is a finished figure.</>}
          {fresh.lastReading && <> The most recent reading arrived {ago(fresh.lastReading)}
            {' '}({clock(fresh.lastReading)}).</>}
          {windowDays ? <> {windowDays} days of daily history travel with this board.</> : null}
        </p>

        <p className="bv-note">
          <b>What this does not establish.</b>{' '}
          Not productivity, not output quality, and not cost. Tokens measure how much a model
          was asked to read and write, which is a measure of volume and of how long context
          was held - a careful hour and a runaway loop can produce the same figure. Nothing
          here knows what any of the work was about: project names, file paths, branches,
          prompt text, session titles, and plan limits are not collected into this board, so
          no ranking on it can be read as a statement about what anybody built.
        </p>
      </div>
    </Card>
  )
}

/* ── segmented control ──────────────────────────────────────────────── */

function Segmented({ label, options, value, onChange }) {
  return (
    <div className="lb-seg" role="group" aria-label={label}>
      {options.map(o => (
        <button
          key={o.key}
          type="button"
          className={'lb-seg-b' + (o.key === value ? ' on' : '')}
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── sparkline ──────────────────────────────────────────────────────────
 *
 * Thirty days of the ranked metric, whatever window is being ranked. A bar
 * chart of "today" is one bar; the shape is what says whether a number is a
 * habit or a spike. */

function Spark({ values, tone }) {
  const vals = values || []
  if (vals.length < 2) return <span className="lb-spark lb-spark--none" />
  const top = Math.max(...vals, 1)
  const w = 4
  const gap = 1
  return (
    <svg className="lb-spark" viewBox={`0 0 ${vals.length * (w + gap)} 24`} preserveAspectRatio="none"
      role="img" aria-label={`${vals.length} days of activity`}>
      {vals.map((v, i) => {
        const h = Math.max(v > 0 ? 1.5 : 0, (v / top) * 22)
        return <rect key={i} x={i * (w + gap)} y={24 - h} width={w} height={h} rx="1" fill={tone} />
      })}
    </svg>
  )
}

/* ── medals and movement ────────────────────────────────────────────── */

const MEDAL = { 1: 'gold', 2: 'silver', 3: 'bronze' }

/* `medals` is off on an analytics board. The position still shows - it is the
   order of the table and hiding it would make the table harder to read - but
   it is a row number, not a placing, and gold paint on the machine you happen
   to work at is a prize for owning a desk. */
function Rank({ rank, medals }) {
  if (rank == null) return <span className="lb-rank lb-rank--off" title="Nothing in this window">-</span>
  const medal = medals ? MEDAL[rank] : null
  return <span className={'lb-rank' + (medal ? ' lb-rank--' + medal : '')}>{rank}</span>
}

function Move({ move, period }) {
  if (move == null) return <span className="lb-move lb-move--flat" title="Not ranked in the previous window">·</span>
  if (move === 0) return <span className="lb-move lb-move--flat" title="Same place as the window before">-</span>
  const up = move > 0
  return (
    <span className={'lb-move ' + (up ? 'lb-move--up' : 'lb-move--down')}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(move)} against the ${period.days}-day window before this one`}>
      {up ? '▲' : '▼'}{Math.abs(move)}
    </span>
  )
}

/* A flame, drawn rather than typed: the Move column already owns arrows, and
   two different meanings behind one glyph is how a table stops being read. */
const Flame = () => (
  <svg className="lb-flame" viewBox="0 0 12 14" aria-hidden="true">
    <path d="M6 0.5c2.6 2.6 4.5 4.6 4.5 7.2A4.5 4.5 0 0 1 6 13.5 4.5 4.5 0 0 1 1.5 7.7C1.5 5.8 2.6 4.4 4 3c.2 1.3.8 2.1 1.6 2.5.6-1.6.6-3.4.4-5z" />
  </svg>
)

function Streak({ streak }) {
  if (!streak || !streak.current) return <span className="lb-streak lb-streak--off">-</span>
  return (
    <span className="lb-streak" title={`Longest run: ${streak.longest} days`}>
      <Flame />{streak.current}d
    </span>
  )
}

/* ── tier ───────────────────────────────────────────────────────────── */

export function TierChip({ tier }) {
  return <span className={'lb-tier lb-tier--' + tier.tier.key}>{tier.tier.name}</span>
}

function TierBar({ tier }) {
  if (!tier.next) {
    return <div className="lb-tierbar lb-tierbar--max"><span>Top tier</span></div>
  }
  return (
    <div className="lb-tierbar" title={`${compact(tier.remaining)} more tokens to ${tier.next.name}`}>
      <div className="track"><div className="fill" style={{ width: tier.pct + '%' }} /></div>
      <span>{compact(tier.remaining)} to {tier.next.name}</span>
    </div>
  )
}

/* ── podium ─────────────────────────────────────────────────────────── */

function Podium({ rows, metric, meId }) {
  /* Only entrants that scored. A podium step under somebody who did nothing
     in this window is not a placing, it is a spare plinth. */
  const top = rows.filter(r => r.rank != null && r.rank <= 3)
  if (top.length < 3) return null
  /* Second, first, third - the order a podium is actually built in. */
  const order = [top[1], top[0], top[2]]
  return (
    <div className="lb-podium">
      {order.map(r => (
        <div key={r.id}
          className={'lb-pod lb-pod--' + MEDAL[r.rank] + (r.id === meId ? ' lb-pod--me' : '')}>
          <div className="lb-pod-medal">{r.rank}</div>
          <div className="lb-pod-name">{r.name}</div>
          <div className="lb-pod-value tnum">{fmt(metric, r.value)}</div>
          <TierChip tier={r.tier} />
          <div className="lb-pod-step" />
        </div>
      ))}
    </div>
  )
}

/* ── a row's models, as chips ───────────────────────────────────────── */

function Models({ models }) {
  const top = (models || []).filter(m => m.tokens > 0).slice(0, 3)
  if (!top.length) return <span className="lb-models lb-models--none">-</span>
  const rest = (models || []).filter(m => m.tokens > 0).length - top.length
  return (
    <span className="lb-models">
      {top.map(m => (
        <span key={m.tool + m.model} className="lb-model" title={`${full(m.tokens)} tokens on ${m.model}`}>
          {shortModel(m.model)}
        </span>
      ))}
      {rest > 0 && <span className="lb-model lb-model--more">+{rest}</span>}
    </span>
  )
}

/* ── grouped rankings ───────────────────────────────────────────────────
 *
 * The same measures over a different axis. There is no rank badge and no
 * medal here whatever the unit: an app cannot win a leaderboard, and a model
 * that did 60% of the work is a finding rather than a placing.
 */

function GroupTable({ board, noun, entrants }) {
  const rows = board.rows
  const what = board.grouping.key === 'app' ? 'app' : 'model'
  if (!rows.length) {
    return <Empty>Nothing on this board attributes work to a named {what} yet.</Empty>
  }
  return (
    <div className="bv-table-scroll">
      <table className="bv-table lb-table">
        <thead>
          <tr>
            <th className="lb-c-rank">#</th>
            <th>{what === 'app' ? 'App' : 'Model'}</th>
            <th className="lb-c-bar">{board.metric.label}</th>
            <th className="lb-c-num tnum">All time</th>
            <th className="lb-c-num tnum">{noun === 'account' ? 'Accounts' : 'Machines'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td className="lb-c-rank"><Rank rank={r.rank} medals={false} /></td>
              <td>
                {/* `shortModel` trims a model's date suffix and vendor prefix.
                    An app is not a model and must not be put through it - it
                    is how "Claude Code" would arrive on the page as "Code". */}
                <span className="lb-name">{what === 'model' ? shortModel(r.label) : r.label}</span>
                {r.sub && <div className="lb-meta"><span className="lb-model">{r.sub}</span></div>}
              </td>
              <td className="lb-c-bar">
                <div className="lb-bar">
                  <div className="fill" style={{
                    width: Math.max(r.value > 0 ? 2 : 0, r.pct) + '%',
                    background: r.rank === 1 ? SERIES[0] : 'var(--color-rule-strong)',
                  }} />
                </div>
              </td>
              <td className="lb-c-num tnum">
                {board.metric.unit === 'usd'
                  ? <Cost row={{ estUSD: r.estUSD, priced: r.priced, costBasis: r.costBasis }} />
                  : fmt(board.metric, r.value)}
              </td>
              {/* Depth and breadth are different findings. A model one entrant
                  leans on is a preference; the same tokens spread across the
                  board is a standard, and a lone tokens column hides which. */}
              <td className="lb-c-num tnum" title={`${r.entrants} of ${entrants} ${noun}${entrants === 1 ? '' : 's'}`}>
                {r.entrants}/{entrants}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── the card ───────────────────────────────────────────────────────── */

export default function Leaderboard({
  entries, meId, right, note, title,
  unit, defaultMetric = 'tokens', defaultPeriod = 'week', defaultGroup = 'entrant',
}) {
  const [metric, setMetric] = useState(defaultMetric)
  const [period, setPeriod] = useState(defaultPeriod)
  const [group, setGroup] = useState(defaultGroup)

  /* The frozen fallback, not an inline `|| []`: a fresh array every render
     means the two memos below never hit, and the whole ranking is recomputed
     on every keystroke elsewhere on the page. */
  const list = entries || NO_ENTRIES
  const kind = unit || unitOf(list)
  const account = kind === UNIT_ACCOUNT
  const noun = account ? 'account' : 'machine'
  const grouping = groupingOf(group)
  /* A measure the chosen axis cannot answer falls back to one it can, rather
     than rendering a column of dashes and calling it a ranking. */
  const usable = grouping.metrics.includes(metric) ? metric : grouping.metrics[0]

  const board = useMemo(
    () => rankBoard(list, { metric: usable, period, now: Date.now() }),
    [list, usable, period],
  )
  const groups = useMemo(
    () => (grouping.rows ? rankGroups(list, { by: grouping.key, metric: usable }) : null),
    [list, grouping, usable],
  )

  const rows = board.rows
  const me = rows.find(r => r.id === meId)
  const metricOptions = METRICS.filter(m => grouping.metrics.includes(m.key))

  /* The floor. Below it the board publishes the count and nothing else - not
     the names, not a partial table, and above all not a podium. Rendering it
     here rather than in each caller means no surface can forget it: the gate
     is a property of publishing a ranking of strangers, and it belongs where
     the ranking is drawn. */
  if (account && list.length < MIN_PUBLIC_ENTRANTS) {
    return (
      <Card title={title ?? 'Leaderboard'} right={right}
        note="The community ranking, published once there is a field to rank.">
        <Empty>
          {list.length} account{list.length === 1 ? ' has' : 's have'} opted in so far. The
          ranking publishes at {MIN_PUBLIC_ENTRANTS}. A board of {list.length} is not a
          small leaderboard - a placing in a field this size says more about who happened
          to be on holiday than about anybody&rsquo;s week, and everyone in it could work
          out exactly what everyone else did. Your own machines are ranked against each
          other on Analytics in the meantime, which needs no field at all.
        </Empty>
      </Card>
    )
  }

  return (
    <Card
      title={title ?? (account ? 'Leaderboard' : 'Machines')}
      note={note ?? (account
        ? 'Every opted-in account, ranked. Token counts and model names only - no machines, no projects, no prompts, no paths.'
        : 'Your own machines, side by side. Nobody wins this one: it is here to say where the work happens, not who is ahead.')}
      right={right}
    >
      <div className="lb-controls">
        <Segmented label="Rank by" options={metricOptions} value={usable} onChange={setMetric} />
        {/* Grouping is an axis, not another measure: pick what to count, then
            pick what to total it over. Folding these into one control would
            have offered "rank by model over 7 days", which is not a sentence. */}
        <Segmented label="Group by" options={GROUPINGS} value={group} onChange={setGroup} />
        {grouping.periods && (
          <Segmented label="Over" options={PERIODS} value={period} onChange={setPeriod} />
        )}
      </div>

      {grouping.note && <p className="bv-note">{grouping.note}</p>}

      {!rows.length && (
        <Empty>
          No {noun} has reported yet. This fills in as agents check in - one row per{' '}
          {noun}, ranked by whatever you pick above.
        </Empty>
      )}

      {rows.length > 0 && groups && (
        <>
          <p className="lb-summary">
            <b className="tnum">{groups.rows.length}</b>{' '}
            {grouping.key === 'app' ? 'app' : 'model'}{groups.rows.length === 1 ? '' : 's'} across{' '}
            {rows.length} {noun}{rows.length === 1 ? '' : 's'}, all time.{' '}
            <span className="lb-metric-note">{groups.metric.note}</span>
          </p>
          <GroupTable board={groups} noun={noun} entrants={rows.length} />
        </>
      )}

      {rows.length > 0 && !groups && (
        <>
          <p className="lb-summary">
            <b className="tnum">{fmt(board.metric, board.total)}</b> {board.metric.label.toLowerCase()}
            {' '}across {rows.length} {noun}{rows.length === 1 ? '' : 's'}
            {' '}{board.period.phrase}
            {/* A "#1 of 3" badge on your own laptops is a rank in a field of
                one person. It belongs to the board that has a field. */}
            {account && me && me.rank != null && rows.length > 1 && (
              <> · you are <b>#{me.rank}</b> of {board.ranked}</>
            )}
            . <span className="lb-metric-note">{board.metric.note}</span>
          </p>

          {account && <Podium rows={rows} metric={board.metric} meId={meId} />}

          <div className="bv-table-scroll">
            <table className="bv-table lb-table">
              <thead>
                <tr>
                  <th className="lb-c-rank">#</th>
                  <th>{account ? 'Account' : 'Machine'}</th>
                  {account && <th className="lb-c-tier">Tier</th>}
                  <th className="lb-c-bar">{board.metric.label}</th>
                  <th className="lb-c-num tnum">{board.period.days ? board.period.label : 'All time'}</th>
                  <th className="lb-c-spark">30 days</th>
                  <th className="lb-c-streak">Streak</th>
                  {board.period.days > 0 && <th className="lb-c-move">Move</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className={r.id === meId ? 'lb-me' : undefined}>
                    <td className="lb-c-rank"><Rank rank={r.rank} medals={account} /></td>
                    <td>
                      <div className="lb-who">
                        <span className={'sh-dot sh-dot--' + (r.entry.status === 'up' ? 'ok' : r.entry.status === 'stale' ? 'warn' : 'off')} />
                        <span className="lb-name">{r.name}</span>
                        {r.id === meId && <span className="lb-you">you</span>}
                      </div>
                      <div className="lb-meta">
                        <Models models={r.entry.models} />
                        {r.entry.os && <span className="lb-os">{r.entry.os === 'Darwin' ? 'macOS' : r.entry.os}</span>}
                        {r.entry.lastActive && <span title={r.entry.lastActive}>{ago(r.entry.lastActive)}</span>}
                      </div>
                    </td>
                    {account && (
                      <td className="lb-c-tier">
                        <TierChip tier={r.tier} />
                        <TierBar tier={r.tier} />
                      </td>
                    )}
                    <td className="lb-c-bar">
                      <div className="lb-bar">
                        <div className="fill" style={{
                          width: Math.max(r.value > 0 ? 2 : 0, r.pct) + '%',
                          background: account && r.rank && r.rank <= 3 ? SERIES[0] : 'var(--color-rule-strong)',
                        }} />
                      </div>
                    </td>
                    <td className="lb-c-num tnum">
                      {board.metric.unit === 'usd'
                        ? <Cost row={entryCost(r.entry, r.value)} />
                        : fmt(board.metric, r.value)}
                    </td>
                    <td className="lb-c-spark"><Spark values={r.spark} tone={account && r.rank && r.rank <= 3 ? SERIES[0] : 'var(--color-ink-3)'} /></td>
                    <td className="lb-c-streak"><Streak streak={r.streak} /></td>
                    {board.period.days > 0 && (
                      <td className="lb-c-move"><Move move={r.move} period={board.period} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {rows.length === 1 && !account && !groups && (
        <p className="bv-note lb-solo">
          One machine is reporting, so there is nothing here to compare it against. Enroll a
          second machine - or opt into the community leaderboard, which is where a ranking
          against other people lives.
        </p>
      )}

      {rows.length > 0 && (
        <p className="bv-note lb-foot">
          Value is an estimate at API list prices and is not what anyone was charged; a
          figure with no rate card behind it reads &ldquo;not priced&rdquo; rather than $0, so a
          Codex-heavy {noun} ranks fairly on tokens and is not scored on value at all.
          {/* Re-typing these six names here was a guaranteed drift: the tiers
              are defined once in shared/ranking.mjs, and a copy of them in a
              footnote is a copy that will one day disagree with the chips
              directly above it. */}
          {account && <> Tiers are all-time tokens: {TIERS.map(t => t.name).join(' · ')}.</>}
        </p>
      )}
    </Card>
  )
}

/* The row of tiles a board opens with - the fleet at a glance, before anybody
   scrolls into the ranking. Totals come from `boardTotals` rather than being
   summed again here, because four surfaces each adding the same column up is
   four chances for two tiles on one screen to disagree.

   The tokens tile carries its composition under it. A headline of "4.5B
   tokens" with no split is the number this whole board exists to stop being
   quoted: it is comparable to nothing, not even to itself last month if the
   mix moved. */
export function LeaderboardTiles({ entries: rows }) {
  const entries = rows || []
  const totals = boardTotals(entries)
  const models = new Set(entries.flatMap(e => (e.models || []).filter(m => m.tokens > 0).map(m => m.model)))
  const active = entries.filter(e => e.status === 'up').length
  const busiest = entries.slice().sort((a, b) => (b.totals?.tokens || 0) - (a.totals?.tokens || 0))[0]
  const account = unitOf(entries) === UNIT_ACCOUNT

  const tiles = [
    {
      k: account ? 'Accounts' : 'Machines',
      v: String(entries.length),
      d: active ? `${active} reporting now` : 'none reporting right now',
    },
    { k: 'Tokens', v: compact(totals.tokens), d: full(totals.tokens) },
    {
      k: 'Est. value',
      v: <Cost row={totals} />,
      d: totals.priced ? 'at API list prices · not billed' : 'no rate card for what ran here',
    },
    { k: 'Models', v: String(models.size), d: [...models].slice(0, 2).map(shortModel).join(', ') || '-' },
  ]

  /* A name, not a number - it needs the smaller face, or one long pseudonym
     wraps to three lines and drags the whole row down with it.

     It is withheld on a community board below the publishing threshold, for the
     same reason the ranking itself is: naming the busiest of four opted-in
     accounts is the podium the gate exists to prevent, printed in a tile. */
  if (busiest && !(account && entries.length < MIN_PUBLIC_ENTRANTS)) {
    tiles.push({
      k: 'Leader', v: busiest.name, word: true,
      d: compact(busiest.totals?.tokens || 0) + ' tokens',
    })
  }
  return (
    <>
      <div className="bv-stats bv-tiles">
        {tiles.map(t => (
          <div className="bv-stat" key={t.k}>
            <div className="bv-stat-label">{t.k}</div>
            <div className={'bv-stat-value' + (t.word ? ' lb-stat-word' : ' tnum')}>{t.v}</div>
            <div className="bv-stat-sub">{t.d}</div>
          </div>
        ))}
      </div>
      {totals.tokens > 0 && (
        <div style={{ marginTop: 'var(--space-md)' }}><Composition totals={totals} /></div>
      )}
    </>
  )
}

/* Which models did the work, across everyone on the board. Public by design:
   model names are the part of this the person sharing asked to be visible.

   The rollup is `rankGroups(by: 'model')` - the same axis the ranking above
   offers, so a model's share here cannot come out different from its share
   there. This table used to sum its own copy, and two copies of an aggregate
   is one copy too many. */
export function ModelBoard({ entries }) {
  const board = useMemo(() => rankGroups(entries, { by: 'model', metric: 'tokens' }), [entries])
  const rows = board.rows
  if (!rows.length) return null
  const account = unitOf(entries) === UNIT_ACCOUNT
  const top = rows[0].tokens || 1

  return (
    <Card title="Models" note="Every model this board ran, and how much of the work it did.">
      <div className="bv-table-scroll">
        <table className="bv-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="lb-c-bar">Share</th>
              <th className="lb-c-num tnum">Tokens</th>
              <th className="lb-c-num tnum">Output</th>
              <th className="lb-c-num tnum">Cache read</th>
              <th className="lb-c-num tnum">Est. value</th>
              <th className="lb-c-num tnum">{account ? 'Accounts' : 'Machines'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td>
                  <span className="lb-name">{shortModel(r.label)}</span>
                  <div className="lb-meta"><Pill tone={r.sub === 'codex' ? '' : 'ok'}>{r.sub}</Pill></div>
                </td>
                <td className="lb-c-bar">
                  <div className="lb-bar">
                    <div className="fill" style={{ width: (r.tokens / top) * 100 + '%', background: SERIES[0] }} />
                  </div>
                </td>
                <td className="lb-c-num tnum">{compact(r.tokens)}</td>
                <td className="lb-c-num tnum">{compact(r.output)}</td>
                {/* Beside the total rather than folded into it: on a long agent
                    session this column is most of the row, and a reader who
                    cannot see that will read the total as work done. */}
                <td className="lb-c-num tnum">{compact(r.cacheRead)}</td>
                <td className="lb-c-num tnum"><Cost row={r} /></td>
                <td className="lb-c-num tnum">{r.entrants}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

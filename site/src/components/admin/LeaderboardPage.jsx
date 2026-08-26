import { TipProvider } from '../board/charts'
import { Card } from '../board/panels'
import { ShareButton } from '../board/share'
import Demand from './leaderboard/Demand'
import Live from './leaderboard/Live'
import Models from './leaderboard/Models'
import Standings from './leaderboard/Standings'

/* The Leaderboard section: four pages behind one rail.
 *
 * They are four because they are four different questions, and a single page
 * that answered all of them would answer none of them well:
 *
 *   Standings  who is ahead — the ranking, and a headline above it
 *   Live       what is running at this instant, as counts
 *   Models     which models did the work, how that is shifting, what it costs
 *   Demand     how much, when, and how evenly it is spread
 *
 * The split is also the business shape. Standings is what a team looks at;
 * Models and Demand are what somebody who builds models would pay for, and
 * both are aggregate by construction — nothing on either page names a project,
 * a prompt or a path, because the payload they read cannot carry one. */

export const LEADERBOARD_PAGES = [
  { key: 'standings', label: 'Leaderboard', icon: 'trophy', hint: 'The ranking, and how the fleet is doing' },
  { key: 'live', label: 'Live', icon: 'running', hint: 'What is running right now' },
  { key: 'models', label: 'Models', icon: 'models', hint: 'Which models did the work, and what it cost' },
  { key: 'demand', label: 'Demand', icon: 'activity', hint: 'How much, when, and from whom' },
]

export const LEADERBOARD_KEYS = LEADERBOARD_PAGES.map(p => p.key)

export default function LeaderboardPage({
  board, page, meId, share, shared, onShare, onGoToMachines,
}) {
  const entries = board?.entries || []

  if (!entries.length) {
    return (
      <div className="adm-page adm-page--wide">
        <header className="adm-head">
          <div>
            <h1>Leaderboard</h1>
            <p>Every machine reporting to this board, ranked against the others.</p>
          </div>
        </header>
        <Card warn>
          No machine has reported yet, so there is nothing to rank. Add one from{' '}
          <button className="lb-inline-link" onClick={onGoToMachines}>Token Monitoring</button>{' '}
          — every page here fills in as agents check in.
        </Card>
      </div>
    )
  }

  const shareBtn = share ? <ShareButton live={shared} onOpen={onShare} /> : null

  return (
    <TipProvider>
      <div className="adm-page adm-page--wide">
        {page === 'standings' && <Standings board={board} meId={meId} right={shareBtn} />}
        {page === 'live' && <Live board={board} />}
        {page === 'models' && <Models board={board} />}
        {page === 'demand' && <Demand board={board} />}
      </div>
    </TipProvider>
  )
}

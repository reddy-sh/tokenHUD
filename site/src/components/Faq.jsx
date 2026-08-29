import { READ, spell, TOOLS_KNOWN, TOOLS_READ } from './coverage'

/* Two of these answers were wrong in ways the rest of the page could have
   caught. "Claude Code and Codex CLI today" undercounted the agent's own
   catalogue by three collectors and disagreed with the integrations section a
   screen above it, so both are derived from coverage.js now. And "sends
   nothing anywhere", stated without qualification, described only the free
   local tier on a page whose primary button opens a hosted board - so the
   hosted half now has an answer of its own rather than being the thing a
   reader discovers by clicking.

   These questions are mirrored as FAQPage structured data in index.html.
   Where the wording overlaps it is word for word on purpose: markup that
   quotes an answer the page does not contain is the kind of thing that gets a
   site's rich results turned off. */

const readNames = READ.map(([name]) => name)
const readList = `${readNames.slice(0, -1).join(', ')} and ${readNames[readNames.length - 1]}`

const questions = [
  {
    q: 'Does TokenHUD see my prompts or my code?',
    a: 'No. Prompt text, completion text, source code and tool-call arguments are never read into the payload at all - not filtered out afterwards. The transcript parser reads only the numeric usage fields from assistant records. There is no code path that collects content, so no configuration mistake can expose it.',
  },
  {
    q: 'How do I see how many tokens Claude Code is using?',
    a: "TokenHUD meters Claude Code's token usage live on your own machine. It reads Claude Code's local session transcripts and reports input, output and cache tokens per session, model, and project, plus your plan's five-hour and seven-day usage windows and when they reset.",
  },
  {
    q: 'Which AI coding agents does TokenHUD support?',
    a: `${readList} are read straight off the disk today - ${spell(TOOLS_READ)} of the ${TOOLS_KNOWN} tools TokenHUD tracks. The rest get a tile that says which of four situations they are in: one setting away from being readable, readable but with no TokenHUD collector written for them yet, usage held behind somebody's admin API, or a web product with no local trace at all. An empty tile always says why it is empty, including when the missing piece is ours.`,
  },
  {
    q: 'Does TokenHUD work offline?',
    a: 'Yes. The free tier runs entirely on your machine and sends nothing anywhere - no pricing lookup, no version check, no error report. The agent, the server and the dashboard all run on localhost and the rate card is compiled into the binary, so it works start to finish with the network off.',
  },
  {
    q: 'Is there a hosted version, and what does it send?',
    a: 'Yes, and it is opt-in. Nothing leaves a machine until you enroll it, which is a command you type on that machine, and the agent shows you its read manifest and asks before it opens a file. Once enrolled it sends metrics: token counts, model names, timings, session and tool-call counts, and the computed estimate. It never sends prompts, completions, source, tool-call arguments, file paths or project names, because those are not collected in the first place. The public leaderboard is a further, separate switch you have to turn on yourself.',
  },
  {
    q: 'Is TokenHUD free?',
    a: 'Yes, free forever for one developer on one machine, with unlimited metering and no sampling. A paid per-seat team tier adds cross-machine rollups, shared budgets, retained history and chargeback reports. The free tier is not degraded to drive upgrades.',
  },
  {
    q: 'When does my Claude usage limit reset?',
    a: "TokenHUD reads the real five-hour and seven-day window state that Claude Code caches locally and shows the percentage used with a live countdown to each reset. If that cache is more than an hour old the percentages grey out and are marked stale, while the countdowns stay exact.",
  },
]

export default function Faq() {
  return (
    <section className="wrap section reveal" id="faq">
      <div className="section__head">
        <h2>Questions, answered like a person.</h2>
      </div>

      <div className="faq-list">
        {questions.map((item, i) => (
          <details key={i} className="faq-item">
            <summary>
              <span>{item.q}</span>
              <span className="faq-chev" aria-hidden="true">+</span>
            </summary>
            <div className="faq-body">
              <p>{item.a}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}

const questions = [
  {
    q: 'Does TokenHUD see my prompts or my code?',
    a: 'No. Prompt text, completion text, source code and tool-call arguments are never read into the payload at all — not filtered out afterwards. The transcript parser reads only the numeric usage fields from assistant records. There is no code path that collects content, so no configuration mistake can expose it.',
  },
  {
    q: 'How do I see how many tokens Claude Code is using?',
    a: "TokenHUD meters Claude Code's token usage live on your own machine. It reads Claude Code's local session transcripts and reports input, output and cache tokens per session, model, and project, plus your plan's five-hour and seven-day usage windows and when they reset.",
  },
  {
    q: 'Which AI coding agents does TokenHUD support?',
    a: 'Claude Code and Codex CLI today. TokenHUD also detects Cursor, Gemini CLI, Windsurf, Devin and other assistants installed on the machine and lists them, marking the ones no collector reads yet rather than showing an empty dashboard.',
  },
  {
    q: 'Does TokenHUD work offline?',
    a: 'Yes. The free tier runs entirely on your machine and sends nothing anywhere. The agent, the server and the dashboard all run on localhost, so it works with the network off.',
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

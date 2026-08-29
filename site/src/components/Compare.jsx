import { spell, TOOLS_KNOWN, TOOLS_READ } from './coverage'

export default function Compare() {
  /* Our own row is the one that has to be hardest on itself, because it is the
     only one the reader cannot check against a rival's README. Three of its
     five cells used to overstate: the interface cell claimed SSE for a hosted
     board that polls, the egress cell claimed nothing leaves from a product
     whose primary button opens a cloud board, and the coverage cell counted
     two agents when the agent's own catalogue reads more. The other rows are
     left as they were - a comparison table that quietly revised its
     competitors while correcting itself would be worth less than no table. */
  const tools = [
    {
      name: 'TokenHUD',
      us: true,
      ui: 'Live local board over SSE; the hosted board polls every 20 s',
      data: 'Reads files your agents already wrote - nothing in the request path',
      leaves: 'Nothing at all until you connect a machine; after that, metrics and never content. Pricing ships in the binary, so it costs no lookup either way',
      coverage: `${TOOLS_READ} read off the disk, ${TOOLS_KNOWN} tracked in all`,
      license: 'MIT, free',
    },
    {
      name: 'ccusage',
      ui: 'Terminal reports, live 5-hour blocks, statusline',
      data: 'Reads local agent files; zero-install via npx',
      leaves: 'Fetches model pricing at runtime unless run with --offline',
      coverage: '16 sources - Claude Code, Codex, Copilot CLI, Gemini CLI and more',
      license: 'MIT, free',
    },
    {
      name: 'Claude Code Usage Monitor',
      ui: 'Terminal UI with burn-rate predictions',
      data: 'Reads local Claude Code session logs',
      leaves: 'Nothing, per its README',
      coverage: 'Claude Code first; adapters for others',
      license: 'MIT, free',
    },
    {
      name: 'CodexBar',
      ui: 'macOS menu-bar meters for rate-limit windows',
      data: 'CLI output, plus provider dashboards queried with your browser cookies',
      leaves: 'Requests to providers, made on your behalf',
      coverage: 'Claims dozens of providers; quota focus, not cost accounting',
      license: 'MIT, free · macOS only',
    },
    {
      name: 'tokscale',
      ui: 'Terminal TUI, plus a public leaderboard',
      data: 'Reads local session files of many agents',
      leaves: 'Nothing unless you opt into the leaderboard upload',
      coverage: '50+ coding agents',
      license: 'MIT, free',
    },
    {
      name: 'LiteLLM · Helicone · Langfuse',
      ui: 'Cloud or self-hosted observability platforms',
      data: 'Your API traffic routes through a proxy, or an SDK sends traces',
      leaves: 'Prompts and completions - logging them is the product',
      coverage: 'Any API traffic; cannot see subscription-plan usage',
      license: 'Open core, free tiers; paid cloud plans',
    },
  ]

  return (
    <section className="wrap section reveal" id="compare">
      <div className="section__head">
        <h2>Where it sits among its neighbours.</h2>
        <p>Every tool here is good at its job. The honest differences are shape, not quality.</p>
      </div>

      <div className="compare-scroller" tabIndex={0} role="region" aria-label="Comparison table">
        <table className="compare">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Interface</th>
              <th>How it gets data</th>
              <th>What leaves your machine</th>
              <th>Coverage</th>
              <th>License</th>
            </tr>
          </thead>
          <tbody>
            {tools.map(t => (
              <tr key={t.name} className={t.us ? 'row-us' : ''}>
                <th scope="row">{t.name}</th>
                <td>{t.ui}</td>
                <td>{t.data}</td>
                <td>{t.leaves}</td>
                <td>{t.coverage}</td>
                <td>{t.license}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'var(--space-xl)', maxWidth: 'var(--measure)' }}>
        <p style={{ marginBottom: 'var(--space-sm)' }}>
          <strong>Where the others win, plainly:</strong> ccusage covers sixteen agent sources to
          TokenHUD&rsquo;s {spell(TOOLS_READ)} and installs with one npx command. CodexBar puts
          glanceable quota meters in the menu bar for far more providers. tokscale tracks 50+
          agents. The observability platforms trace whole production applications.
        </p>
        <p style={{ color: 'var(--color-ink-2)' }}>
          <strong>What none of them holds together:</strong> a live board rather than a report,
          on loopback, with nothing in the request path and nothing leaving the machine unless
          you ask for it &mdash; not even a pricing lookup.
        </p>
      </div>
    </section>
  )
}

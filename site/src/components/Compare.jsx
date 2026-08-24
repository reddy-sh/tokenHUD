export default function Compare() {
  const tools = [
    {
      name: 'TokenHUD',
      us: true,
      ui: 'Live local web board, pushed over SSE',
      data: 'Reads files your agents already wrote — nothing in the request path',
      leaves: 'Nothing. The rate card ships in the binary; it runs with the network off',
      coverage: 'Claude Code + Codex CLI read; seven more detected',
      license: 'MIT, free',
    },
    {
      name: 'ccusage',
      ui: 'Terminal reports, live 5-hour blocks, statusline',
      data: 'Reads local agent files; zero-install via npx',
      leaves: 'Fetches model pricing at runtime unless run with --offline',
      coverage: '16 sources — Claude Code, Codex, Copilot CLI, Gemini CLI and more',
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
      leaves: 'Prompts and completions — logging them is the product',
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
          TokenHUD's two and installs with one npx command. CodexBar puts glanceable quota meters
          in the menu bar for far more providers. tokscale tracks 50+ agents. The observability
          platforms trace whole production applications.
        </p>
        <p style={{ color: 'var(--color-ink-2)' }}>
          <strong>What none of them holds together:</strong> a live board rather than a report,
          on loopback, with nothing in the request path and nothing leaving the machine — not
          even a pricing lookup.
        </p>
      </div>
    </section>
  )
}

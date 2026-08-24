export default function Integrations() {
  const detected = ['Cursor', 'Gemini CLI', 'GitHub Copilot', 'Windsurf', 'Antigravity', 'Aider', 'Devin']

  return (
    <section className="wrap section reveal" id="integrations">
      <div className="section__head">
        <h2>Nine agents. Two fully read. Seven detected.</h2>
        <p>Detected and read are different facts, and the board refuses to conflate them.</p>
      </div>

      <div className="int-grid">
        <div className="int-card">
          <h3>Claude Code <span className="tag tag--read">read by the board</span></h3>
          <p>Sessions, tokens, spend and your plan's real usage windows — everything the
            board shows, with no configuration.</p>
        </div>
        <div className="int-card">
          <h3>Codex CLI <span className="tag tag--read">read by the board</span></h3>
          <p>Sessions, tokens and rate limits, counted exactly. Codex tokens are shown
            unpriced rather than priced with a made-up rate card.</p>
        </div>
      </div>

      <div className="int-card" style={{ marginBottom: 'var(--space-lg)' }}>
        <h3>Detected on your machine <span className="tag tag--soon">collectors coming</span></h3>
        <ul className="detected-list">
          {detected.map(name => <li key={name}>{name}</li>)}
        </ul>
        <p style={{ marginTop: 'var(--space-md)' }}>
          Installed tools are listed and marked plainly when nothing reads them yet — never shown
          as an empty board that looks broken. Want yours next?{' '}
          <a href="https://github.com/reddy-sh/tokenhud/issues" style={{ color: 'var(--color-accent)' }}>
            Open an issue.
          </a>
        </p>
      </div>
    </section>
  )
}

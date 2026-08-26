/* The four states a tool can be in, which is the honest shape of this
   market: a few write real token counts to disk, a few would with one
   setting changed, most keep the numbers on their own servers, and some
   are web products that never touch your machine at all. */
const READ = [
  ['Claude Code', 'Sessions, tokens, spend and your plan’s real usage windows — no configuration.'],
  ['Codex CLI', 'Sessions, tokens and rate limits, counted exactly and shown unpriced rather than priced with a made-up rate card.'],
  ['GitHub Copilot CLI', 'Input, output and cache tokens per model, plus premium requests and AI units, from the CLI’s own session events.'],
  ['Devin CLI', 'Credits and ACU per session with model and mode, read from the local session store. Conversations are counted, never opened.'],
]

const SETUP = [
  ['Gemini CLI', 'One telemetry block in settings.json and every API call logs its six token counts locally.'],
  ['Cline, Roo Code, Kilo Code', 'Per-task tokens and cost, tracked by default. Install the extension and use it.'],
  ['OpenCode, Goose, LM Studio', 'Per-session token counts in a local store — SQLite or JSONL, depending on the build.'],
  ['Aider, Continue.dev', 'Local analytics that carry per-message tokens once switched on.'],
]

const API = [
  ['Cursor', 'A team admin key reaches per-request tokens. A personal Pro plan has no usage API at all.'],
  ['GitHub Copilot in the IDE', 'Premium requests via the billing API — individually, or org-wide with an owner’s token.'],
  ['Windsurf', 'Credits, not tokens, and only with a team service key.'],
  ['Amazon Q Developer', 'No token metric exists in any report. The board says so instead of implying one.'],
]

export default function Integrations() {
  return (
    <section className="wrap section reveal" id="integrations">
      <div className="section__head">
        <h2>Twenty-six tools tracked. Four read straight off the disk.</h2>
        <p>
          Detected, readable and read are three different facts, and the board refuses to
          conflate them. Every tool it knows about gets a tile — and a tile with no numbers
          tells you what would give it some.
        </p>
      </div>

      <div className="int-grid">
        {READ.map(([name, note]) => (
          <div className="int-card" key={name}>
            <h3>{name} <span className="tag tag--read">read by the board</span></h3>
            <p>{note}</p>
          </div>
        ))}
      </div>

      <div className="int-card" style={{ marginBottom: 'var(--space-lg)' }}>
        <h3>A step away <span className="tag tag--soon">local, once enabled</span></h3>
        <ul className="detected-list">
          {SETUP.map(([name, note]) => <li key={name}><b>{name}</b> — {note}</li>)}
        </ul>
      </div>

      <div className="int-card">
        <h3>Usage lives on their servers <span className="tag tag--soon">needs a key</span></h3>
        <ul className="detected-list">
          {API.map(([name, note]) => <li key={name}><b>{name}</b> — {note}</li>)}
        </ul>
        <p style={{ marginTop: 'var(--space-md)' }}>
          Replit, v0, Bolt and Lovable are web products and leave no local trace, so the board
          lists them and claims nothing. Want yours read properly?{' '}
          <a href="https://github.com/reddy-sh/tokenhud/issues" style={{ color: 'var(--color-accent)' }}>
            Open an issue.
          </a>
        </p>
      </div>
    </section>
  )
}

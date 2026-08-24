export default function Manifest() {
  return (
    <section className="wrap section reveal" id="manifest">
      <div className="section__head">
        <h2>It names every file it will open, before it opens one.</h2>
        <p>Run this before you trust anything else here.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-xl)', alignItems: 'start' }}>
        <div className="code-card">
          <div className="code-card__label">
            <span>tokenhud-agent --what-i-read</span>
            <span>abridged</span>
          </div>
          <pre>{`~/.claude/projects/**/*.jsonl
`}<span className="c">  per-session token counts, models, timings</span>{`
`}<span className="c">  └ only lines whose type is </span><span className="k">assistant</span><span className="c"> or </span><span className="k">ai-title</span>{`

~/.claude.json
`}<span className="c">  exactly one key: </span><span className="k">cachedUsageUtilization</span>{`
`}<span className="c">  └ never oauthAccount · never projects</span>{`

~/.codex/sessions/**
`}<span className="c">  token_count events — the last record per file</span>{`

`}<span className="k">NEVER READ</span>{`
`}<span className="c">  prompt text · session titles   opt-in, off by default</span>{`
`}<span className="c">  your source code               no collector opens a file</span>{`
`}<span className="c">                                 outside the paths above</span></pre>
        </div>

        <div>
          <p>Resolved against <strong>your</strong> machine — real files, real sizes, not a
            description. Nothing is read at all until you agree.</p>
          <p style={{ marginTop: 'var(--space-md)' }}>A release that reads one more file has to ask you again. Tests in the
            repository hold that list to the code that does the reading.</p>
          <p style={{ marginTop: 'var(--space-md)', color: 'var(--color-ink-3)', fontSize: 'var(--text-sm)' }}>
            <a href="https://github.com/reddy-sh/tokenhud#it-tells-you-every-file-it-will-open-before-it-opens-one"
               style={{ color: 'var(--color-accent)' }}>
              How that works, in detail — on GitHub →
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}

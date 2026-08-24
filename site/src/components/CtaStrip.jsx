import { useState, useCallback } from 'react'

export default function CtaStrip({ onDashboard }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = 'git clone https://github.com/reddy-sh/tokenhud.git\ncd tokenhud && ./scripts/build.sh && ./scripts/run.sh'
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }, [])

  return (
    <section className="wrap cta-strip reveal">
      <h2>Two commands after the clone.</h2>
      <p>It shows you what it reads, asks first, and starts everything. Needs cargo; the build takes about thirty seconds.</p>

      <div className="code-card" style={{ maxWidth: '600px', margin: '0 auto var(--space-xl)', textAlign: 'left' }}>
        <div className="code-card__label">
          <span>terminal</span>
          <button
            onClick={handleCopy}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: copied ? 'var(--color-success)' : 'var(--color-ink-3)',
              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
        <pre>
          <span className="c">$</span> git clone https://github.com/reddy-sh/tokenhud.git{'\n'}
          <span className="c">$</span> cd tokenhud && ./scripts/build.sh && ./scripts/run.sh
        </pre>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--primary" onClick={onDashboard}>
          <span>Open Dashboard</span>
          <span aria-hidden="true">→</span>
        </button>
        <a className="btn btn--ghost" href="https://github.com/reddy-sh/tokenhud">
          View the source on GitHub
        </a>
      </div>
    </section>
  )
}

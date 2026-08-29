import { useState, useCallback } from 'react'

/* The single most damaging thing on this page, until now, was here.
 *
 * The headline said "Two commands after the clone" and the block underneath
 * offered `./scripts/build.sh && ./scripts/run.sh`. Neither script has ever
 * existed: `scripts/` holds `install.sh`, `status.sh` and the `start-`/`stop-`
 * pairs, and nothing in the repository is named build.sh or run.sh. So the one
 * command on the site a reader was most likely to copy was the one guaranteed
 * to fail, at the exact moment they had decided to trust the thing. The copy
 * button put it on their clipboard, which is worse than printing it.
 *
 * What replaces it is the path the README actually documents, and the shorter
 * one: a prebuilt static binary from this site's own origin. No clone, no
 * cargo, no thirty-second build to apologise for. `install.sh` is served out
 * of site/public/ and there is a test that asserts the site serves it, so this
 * command cannot rot the way the old one did without something going red.
 *
 * The second line is `--what-i-read`, and it is here rather than in the
 * manifest section because of what it is: the only claim on this page a reader
 * can verify against their own machine in five seconds, before agreeing to
 * anything. It reads nothing. That belongs next to the button. */

const INSTALL = 'curl -fsSL https://tokenhud.com/install.sh | sh'
const MANIFEST = 'tokenhud-agent --what-i-read'

export default function CtaStrip({ cta, onPortal }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(`${INSTALL}\n${MANIFEST}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    })
  }, [])

  return (
    <section className="wrap cta-strip reveal">
      <h2>One command to install it. One to check it.</h2>
      <p>A prebuilt static binary - no clone, no cargo, no package manager. The second command
        opens no files: it prints every path the agent would ever read, resolved against your
        machine, so you can read the list before agreeing to it.</p>

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
          <span className="c">$</span> {INSTALL}{'\n'}
          <span className="c">$</span> {MANIFEST}
        </pre>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-md)', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--primary" onClick={onPortal}>
          <span>{cta}</span>
          <span aria-hidden="true">→</span>
        </button>
        <a className="btn btn--ghost" href="https://github.com/reddy-sh/tokenhud">
          View the source on GitHub
        </a>
      </div>

      <p style={{ marginTop: 'var(--space-lg)', fontSize: 'var(--text-sm)', color: 'var(--color-ink-3)' }}>
        Running the whole thing yourself, server included, is a clone and{' '}
        <code>scripts/install.sh</code> -{' '}
        <a href="https://github.com/reddy-sh/tokenhud/blob/main/INSTALL.md"
           style={{ color: 'var(--color-accent)' }}>
          INSTALL.md
        </a>{' '}
        covers it.
      </p>
    </section>
  )
}

export default function Footer() {
  return (
    <footer className="wrap footer">
      <p className="footer__statement">
        Metrics leave. <b>Content never does.</b>
      </p>
      <div className="footer__meta">
        <span className="wordmark">Token<b><abbr title="Heads-Up Display">HUD</abbr></b></span>
        <nav className="footer__links" aria-label="Footer">
          <a href="https://github.com/reddy-sh/tokenhud">GitHub</a>
          <a href="https://github.com/reddy-sh/tokenhud/blob/main/INSTALL.md">Install</a>
          <a href="https://github.com/reddy-sh/tokenhud/blob/main/docs/ARCHITECTURE.md">Architecture</a>
          <a href="https://github.com/reddy-sh/tokenhud/blob/main/SECURITY.md">Security</a>
          <a href="/llms.txt">llms.txt</a>
        </nav>
        <span>MIT · © 2026 TokenHUD</span>
      </div>
    </footer>
  )
}

export default function Pricing() {
  return (
    <section className="wrap section reveal" id="pricing">
      <div className="section__head">
        <h2>Free where it runs alone.</h2>
        <p>A free user costs nothing to serve, because nothing is served — it all happens on your machine.</p>
      </div>

      <div className="pricing-grid">
        <div className="price-card">
          <h3>Solo <span className="tag tag--read">available now</span></h3>
          <p className="price-card__price tnum">$0 <span>free forever — one developer, one machine</span></p>
          <ul>
            <li>Unlimited metering, no sampling</li>
            <li>Full local history in SQLite you own</li>
            <li>Plan windows with live reset countdowns</li>
            <li>Runs with the network off</li>
            <li>Every line of it open source</li>
          </ul>
          <p className="price-card__foot">No account, no key ceremony, no upsell banners on the board.</p>
        </div>

        <div className="price-card price-card--planned">
          <h3>Team <span className="tag tag--soon">planned</span></h3>
          <p className="price-card__price">Per seat <span>price not set</span></p>
          <ul>
            <li>Cross-machine rollups</li>
            <li>Shared budgets and policies</li>
            <li>Retained history and chargeback reports</li>
            <li>Alerts to Slack and email</li>
            <li>Admin roles</li>
          </ul>
          <p className="price-card__foot">
            The roadmap is a plan, not a description.{' '}
            <a href="https://github.com/reddy-sh/tokenhud" style={{ color: 'var(--color-accent)' }}>Watch the repo</a> to hear when it exists.
          </p>
        </div>
      </div>

      <p style={{ marginTop: 'var(--space-xl)', color: 'var(--color-ink-2)', maxWidth: 'var(--measure)' }}>
        <strong style={{ color: 'var(--color-ink)' }}>The free tier will not be degraded to drive
          upgrades.</strong> The upgrade trigger is other people — the moment a second developer
        needs to see the same numbers — not an artificial ceiling on the first one.
      </p>
    </section>
  )
}

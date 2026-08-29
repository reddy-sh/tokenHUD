import { useEffect, useRef } from 'react'

export default function Hero({ cta, onPortal }) {
  const spotRef = useRef(null)
  const heroRef = useRef(null)

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const hero = heroRef.current
    const spot = spotRef.current
    if (!hero || !spot) return
    const onMove = e => {
      const r = hero.getBoundingClientRect()
      spot.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%')
      spot.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%')
    }
    hero.addEventListener('mousemove', onMove, { passive: true })
    return () => hero.removeEventListener('mousemove', onMove)
  }, [])

  return (
    <section className="hero" id="top" ref={heroRef}>
      <div className="hero__spotlight" ref={spotRef} aria-hidden="true" />

      <div className="hero__rail">
        <span className="hero__rail-dot" aria-hidden="true" />
        <span>TOKENHUD — a heads-up display for your AI agents · open source · MIT</span>
      </div>

      <h1 className="hero__display">
        Know what your<br />agents cost.
      </h1>

      {/* Two overclaims lived in this paragraph. "Every AI coding agent on your
          machine" is not true of any tool and is not true of this one - the
          agent's catalogue knows several times as many tools as it can read,
          and the integrations section says so plainly a screen down, so the
          hero was being contradicted by its own page. And "Runs on localhost",
          full stop, described only half the product: the button four inches to
          the left opens a hosted board. Both are fixed here rather than
          softened, because the local half is the strongest thing on the page
          and the hosted half is opt-in - saying so in the first paragraph turns
          a contradiction the reader would otherwise discover into a choice they
          are being offered. */}
      <p className="hero__sub">
        Live token metering, estimated spend and plan-limit windows for the AI coding agents on your machine.
        Runs on localhost, reads files your agents already wrote, and never touches your prompts or code.
        Connect it to the hosted board when you want a second machine in the picture - metrics leave, content never does.
      </p>

      <div className="hero__actions">
        <button className="btn btn--primary" onClick={onPortal}>
          <span>{cta}</span>
          <span aria-hidden="true">→</span>
        </button>
        <a className="btn btn--ghost" href="https://github.com/reddy-sh/tokenhud">
          View on GitHub
        </a>
      </div>
    </section>
  )
}

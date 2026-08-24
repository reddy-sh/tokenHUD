import { useEffect, useRef } from 'react'

export default function Hero({ onDashboard }) {
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
        <span>TOKENHUD — live agent monitoring · open source · MIT</span>
      </div>

      <h1 className="hero__display">
        Know what your<br />agents cost.
      </h1>

      <p className="hero__sub">
        Live token metering, estimated spend and plan-limit windows for every AI coding agent on your machine.
        Runs on localhost. Reads files your agents already wrote. Never touches your prompts or code.
      </p>

      <div className="hero__actions">
        <button className="btn btn--primary" onClick={onDashboard}>
          <span>Open Dashboard</span>
          <span aria-hidden="true">→</span>
        </button>
        <a className="btn btn--ghost" href="https://github.com/reddy-sh/tokenhud">
          View on GitHub
        </a>
      </div>
    </section>
  )
}

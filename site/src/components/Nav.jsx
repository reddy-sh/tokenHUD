import { useEffect, useRef } from 'react'

export default function Nav({ onDashboard }) {
  const navRef = useRef(null)

  useEffect(() => {
    const onScroll = () => {
      if (navRef.current) navRef.current.classList.toggle('is-scrolled', window.scrollY > 8)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className="nav" ref={navRef}>
      <div className="nav__inner">
        <a className="nav__brand" href="#top" aria-label="TokenHUD home">
          <span className="nav__brand-dot" aria-hidden="true" />
          <span>Token<b>HUD</b></span>
        </a>
        <nav className="nav__links" aria-label="Primary">
          <a href="#board">Board</a>
          <a href="#boundary">Privacy</a>
          <a href="#integrations">Agents</a>
          <a href="#compare">Compare</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <button className="nav__cta" onClick={onDashboard}>
          <span>Open Dashboard</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </header>
  )
}

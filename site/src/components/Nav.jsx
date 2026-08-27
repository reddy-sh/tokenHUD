import { useEffect, useRef } from 'react'
import GitHubStars from './GitHubStars'

export default function Nav({ cta, onPortal }) {
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
          {/* The nav had no link to the repository at all, on a page whose
              second-largest button says "View on GitHub" and whose licence is
              the third word of the hero. Both halves go at the end of the links
              rather than beside the CTA, because the nav is a three-column grid
              and a fourth child would drop to a row of its own; here they
              inherit the link styling for free and hide on narrow screens with
              the rest of the links, where the footer's GitHub link takes over.

              The link and the count are two elements on purpose. The link is
              unconditionally true - this is an MIT project and that is where it
              lives - so it renders on every build, including one with no cloud
              backend to ask for a count. The count is a fact we may not have,
              and when we do not have it, it removes itself rather than leaving
              a placeholder hanging off the end of the word GitHub. */}
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            <a href="https://github.com/reddy-sh/tokenhud">GitHub</a>
            <GitHubStars />
          </span>
        </nav>
        <button className="nav__cta" onClick={onPortal}>
          <span>{cta}</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </header>
  )
}

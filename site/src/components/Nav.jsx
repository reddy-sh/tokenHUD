import { useEffect, useRef, useState } from 'react'

const LINKS = [
  ['#board', 'Board'],
  ['#boundary', 'Privacy'],
  ['#integrations', 'Agents'],
  ['#compare', 'Compare'],
  ['#pricing', 'Pricing'],
]

export default function Nav({ cta, onPortal }) {
  const navRef = useRef(null)
  /* Below 768px the links do not fit beside the brand and the call to action,
     and the stylesheet used to resolve that by hiding them outright — which
     left a phone with a header of two buttons and no way to reach Board,
     Privacy, Agents, Compare or Pricing at all. They fold into a panel under
     the bar instead. */
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => {
      if (navRef.current) navRef.current.classList.toggle('is-scrolled', window.scrollY > 8)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  /* Anything that moves the page closes the panel: a link scrolls to a section
     the panel is covering, Escape is the reflex, and a tap outside is what a
     panel over content is expected to answer to. */
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e) => { if (!navRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [open])

  return (
    <header className={'nav' + (open ? ' nav--open' : '')} ref={navRef}>
      <div className="nav__inner">
        <button
          type="button"
          className="nav__menubtn"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="nav-links"
          onClick={() => setOpen(o => !o)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            {open ? (
              <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            ) : (
              <path d="M2.5 5h13M2.5 9h13M2.5 13h13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <a className="nav__brand" href="#top" aria-label="TokenHUD — Token Heads-Up Display">
          <span className="nav__brand-dot" aria-hidden="true" />
          <span>Token<b>HUD</b></span>
        </a>
        <nav className="nav__links" id="nav-links" aria-label="Primary">
          {LINKS.map(([href, label]) => (
            <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>
          ))}
        </nav>
        <button className="nav__cta" onClick={onPortal}>
          <span>{cta}</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </header>
  )
}

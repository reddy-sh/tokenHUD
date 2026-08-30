import { useCallback, useEffect, useState } from 'react'

/* The section rail, on a phone.
 *
 * The admin shell is three columns — root rail, section rail, content — and
 * below 768px there is only room for two. The stylesheet used to resolve that
 * by hiding the section rail outright, which is the one rail that carries the
 * machine list, the assistants, every board section and the Leaderboard's own
 * pages. The result was a board a phone could scroll and could not navigate.
 *
 * So on mobile it becomes a drawer over the content, the same pattern
 * `.bv-rail` already uses on the self-host board, opened by the topbar's
 * hamburger — a button that until now toggled the root rail between icons and
 * labels, which is a distinction mobile does not have because the root rail is
 * always icons there. Same button, the meaning it should have had. */

export const MOBILE_NAV = '(max-width: 768px)'

const isMobile = () => window.matchMedia(MOBILE_NAV).matches

export function useMobileNav({ setCollapsed, toggleRoot }) {
  const [navOpen, setNavOpen] = useState(false)
  const closeNav = useCallback(() => setNavOpen(false), [])

  const onHamburger = useCallback(() => {
    if (!isMobile()) return toggleRoot()
    setNavOpen(open => {
      // A drawer 300px wide showing nothing but icon stubs is a drawer for
      // nothing, so opening it also un-minis the rail. Deliberately not saved:
      // this is a mobile session making itself usable, not a person changing
      // the preference their desktop reads back.
      if (!open) setCollapsed(false)
      return !open
    })
  }, [setCollapsed, toggleRoot])

  /* Every row in the rail navigates somewhere, so once one is picked the
     drawer has done its job. Listened for here rather than threaded through
     two rail components that have four different callbacks between them. */
  useEffect(() => {
    if (!navOpen) return
    const onClick = (e) => { if (e.target.closest?.('.adm-side .adm-item')) setNavOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false) }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [navOpen])

  /* Widening back to desktop leaves the drawer state set but invisible, and
     the next hamburger press would then appear to do nothing. */
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_NAV)
    const onChange = () => { if (!mq.matches) setNavOpen(false) }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return { navOpen, onHamburger, closeNav }
}

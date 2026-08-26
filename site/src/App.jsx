import { fetchUserAttributes, getCurrentUser } from 'aws-amplify/auth'
import { useEffect, useState } from 'react'
import Board from './components/Board'
import Boundary from './components/Boundary'
import Compare from './components/Compare'
import CtaStrip from './components/CtaStrip'
import Faq from './components/Faq'
import Footer from './components/Footer'
import GlobalBoard from './components/GlobalBoard'
import Hero from './components/Hero'
import Integrations from './components/Integrations'
import Manifest from './components/Manifest'
import Nav from './components/Nav'
import Portal from './components/Portal'
import Pricing from './components/Pricing'
import PublicBoard, { parseShareHash } from './components/PublicBoard'
import SelfHost from './components/SelfHost'
import Stats from './components/Stats'
import { cloudConfigured } from './lib/cloud'

function parseRoute(hash) {
  if (hash === '#/leaderboard') return { page: 'leaderboard' }
  const share = parseShareHash(hash)
  if (share) return { page: 'share', ...share }
  return null
}

/* The dashboard lives at platform.tokenhud.com — same build artifact, but the
   React app checks the hostname to skip the marketing page and render the
   portal directly. On tokenhud.com the CTA navigates to the platform. */
const isPlatform = location.hostname === 'platform.tokenhud.com'
const platformUrl = 'https://platform.tokenhud.com'

export default function App() {
  /* Routes this site has. A shared board or global leaderboard is a whole page
     rather than a panel on the marketing one — the person opening the link did
     not come for the pitch, and the link has to survive a reload and a paste
     into Slack. */
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  const [portalOpen, setPortalOpen] = useState(isPlatform)
  /* 'cloud' = Cognito portal, 'local' = self-host board */
  const [portalMode, setPortalMode] = useState(isPlatform ? 'cloud' : null)
  /* undefined = still asking Cognito, null = signed out, string = the email */
  const [user, setUser] = useState(cloudConfigured ? undefined : null)

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  /* Does a session already exist? Decides whether the buttons say
     "Sign in" or "Open your board". */
  useEffect(() => {
    if (!cloudConfigured) return
    let cancelled = false
    ;(async () => {
      try {
        await getCurrentUser()
        const attrs = await fetchUserAttributes().catch(() => ({}))
        if (!cancelled) setUser(attrs.email || 'signed in')
      } catch {
        if (!cancelled) setUser(null)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /* scroll-triggered reveals */
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-in'))
      return
    }
    const obs = new IntersectionObserver(
      entries => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-in'); obs.unobserve(e.target) } }),
      { threshold: 0.12 }
    )
    document.querySelectorAll('.reveal').forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [])

  const openPortal = () => {
    /* Cloud backend on the marketing site: send them to the platform. */
    if (cloudConfigured && !isPlatform) {
      window.location.href = platformUrl
      return
    }
    /* No cloud backend: go straight to the self-host board. */
    if (!cloudConfigured) {
      setPortalMode('local')
    } else {
      setPortalMode('cloud')
    }
    setPortalOpen(true)
  }

  const closePortal = () => {
    setPortalOpen(false)
    setPortalMode(null)
  }

  const cta = user ? 'Open your board' : (cloudConfigured ? 'Sign in' : 'Open your board')

  /* Checked after the hooks above, never before them: a component that runs a
     different number of hooks depending on the URL is a component that breaks
     the first time somebody navigates. */
  if (route?.page === 'leaderboard') return <GlobalBoard />
  if (route?.page === 'share') return <PublicBoard route={route} />

  /* platform.tokenhud.com: render the portal full-page, no marketing shell. */
  if (isPlatform) {
    return (
      <Portal
        user={user} onUser={setUser}
        onClose={() => { window.location.href = 'https://tokenhud.com' }}
        onSelfHost={() => setPortalMode('local')}
      />
    )
  }

  return (
    <>
      {/* ambient backdrop */}
      <div className="ambient" aria-hidden="true">
        <div className="bloom bloom--1" />
        <div className="bloom bloom--2" />
        <div className="grain" />
      </div>

      <a className="skip" href="#main">Skip to content</a>

      <Nav cta={cta} onPortal={openPortal} />

      <main id="main">
        <Hero cta={cta} onPortal={openPortal} />
        <Stats />
        <Board />
        <Manifest />
        <Boundary />
        <Integrations />
        <Compare />
        <Pricing />
        <Faq />
        <CtaStrip cta={cta} onPortal={openPortal} />
      </main>

      <Footer />

      {portalOpen && portalMode === 'local' && (
        <SelfHost onClose={closePortal} />
      )}
    </>
  )
}

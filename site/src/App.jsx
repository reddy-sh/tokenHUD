import { fetchUserAttributes, getCurrentUser } from 'aws-amplify/auth'
import { lazy, Suspense, useEffect, useState } from 'react'
import Board from './components/Board'
import Boundary from './components/Boundary'
import Compare from './components/Compare'
import CtaStrip from './components/CtaStrip'
import Faq from './components/Faq'
import Footer from './components/Footer'
import Hero from './components/Hero'
import Integrations from './components/Integrations'
import Manifest from './components/Manifest'
import Modes from './components/Modes'
import Nav from './components/Nav'
import Pricing from './components/Pricing'
import Stats from './components/Stats'
import { cloudConfigured } from './lib/cloud'

/* ── what this page downloads, and what it does not ──────────────────────
 *
 * Everything used to be one chunk. A visitor who came to read the pitch, got
 * to the pricing table and left had by then downloaded the whole dashboard,
 * the enrollment flow, every chart, both leaderboards and the shared-board
 * page - none of which any of them could have reached without first clicking
 * a button. `grep -c "import(" src` returned zero.
 *
 * So the four routes and panels a marketing visitor does not see are behind
 * `lazy`, and the marketing sections above are not. The split follows what a
 * first-time reader actually needs, which is the page they landed on.
 *
 * Every `Suspense` here falls back to `null` rather than a spinner. These
 * boundaries wrap whole pages and one below-the-fold section: a spinner in
 * place of a page the person just navigated to is noise, and a skeleton in
 * place of a section they have not scrolled to yet is a promise about content
 * that may turn out not to exist. Nothing on this page draws a shape it does
 * not have.
 */
const Portal = lazy(() => import('./components/Portal'))
const SelfHost = lazy(() => import('./components/SelfHost'))
const PublicBoard = lazy(() => import('./components/PublicBoard'))
const GlobalBoard = lazy(() => import('./components/GlobalBoard'))
const Community = lazy(() => import('./components/Community'))

/* A share link is recognised here and parsed there.
 *
 * `parseShareHash` lives in PublicBoard.jsx because that module owns the link
 * format, and it should keep owning it. But importing the function directly
 * would drag the whole shared-board page - its charts, its rails, its
 * leaderboard - into the chunk every marketing visitor blocks on, for eight
 * lines of regex. So the hash is matched against the route prefix to know a
 * share link when we see one, and the real parse happens in the effect below,
 * inside the chunk that is loading anyway because it is about to render. */
function parseRoute(hash) {
  if (hash === '#/leaderboard') return { page: 'leaderboard' }
  /* The hash is carried along so the parse can be matched back to the link it
     came from. Somebody who pastes a second board link into the bar while the
     first is still loading must not be shown the first one's board. */
  if (/^#\/b\//.test(hash)) return { page: 'share', hash }
  return null
}

/* The dashboard lives at platform.tokenhud.com - same build artifact, but the
   React app checks the hostname to skip the marketing page and render the
   portal directly. On tokenhud.com the CTA navigates to the platform. */
const isPlatform = location.hostname === 'platform.tokenhud.com'
const platformUrl = 'https://platform.tokenhud.com'

export default function App() {
  /* Routes this site has. A shared board or global leaderboard is a whole page
     rather than a panel on the marketing one - the person opening the link did
     not come for the pitch, and the link has to survive a reload and a paste
     into Slack. */
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  /* The parsed share link, tagged with the hash it was parsed from: null until
     PublicBoard's chunk has arrived, then {hash, value} where value is the
     board to read or null for a link that does not parse. It is not cleared
     when the route changes - it is matched against the current hash instead,
     which needs no second render to become correct. */
  const [share, setShare] = useState(null)
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

  useEffect(() => {
    if (route?.page !== 'share') return
    const { hash } = route
    let live = true
    import('./components/PublicBoard').then(m => {
      if (live) setShare({ hash, value: m.parseShareHash(hash) })
    })
    return () => { live = false }
  }, [route])

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
    /* Production marketing site: send visitors to the platform subdomain.
       On localhost (dev) the portal opens inline so tests and development
       work without a redirect. */
    const isMarketingSite = location.hostname === 'tokenhud.com'
      || location.hostname === 'www.tokenhud.com'
    if (cloudConfigured && isMarketingSite) {
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
  if (route?.page === 'leaderboard') {
    return <Suspense fallback={null}><GlobalBoard /></Suspense>
  }
  if (route?.page === 'share') {
    const parsed = share?.hash === route.hash ? share.value : undefined
    /* A share hash that turns out not to parse falls through to the marketing
       page, which is what it did before this was split in two. Until the parse
       lands there is nothing to render and nothing worth claiming: an empty
       page for one round trip is honest, a spinner promising a board that may
       not exist is not. */
    if (parsed) return <Suspense fallback={null}><PublicBoard route={parsed} /></Suspense>
    if (parsed === undefined) return null
  }

  /* platform.tokenhud.com: render the portal full-page, no marketing shell. */
  if (isPlatform) {
    return (
      <Suspense fallback={null}>
        <Portal
          user={user} onUser={setUser}
          onClose={() => { window.location.href = 'https://tokenhud.com' }}
          onSelfHost={() => setPortalMode('local')}
        />
      </Suspense>
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
        {/* Boundary draws the line inside the machine; Modes draws it at the
            edge of the machine. They belong next to each other, and in that
            order, because the second only makes sense once the first has
            established that content is never collected in the first place. */}
        <Modes />
        <Integrations />
        <Compare />
        {/* Lazy, and with nothing in its place while it loads: the section is
            below the fold, everything in it comes off the network anyway, and
            it renders nothing at all until it has real entries to draw. */}
        <Suspense fallback={null}><Community /></Suspense>
        <Pricing />
        <Faq />
        <CtaStrip cta={cta} onPortal={openPortal} />
      </main>

      <Footer />

      {portalOpen && portalMode === 'local' && (
        <Suspense fallback={null}><SelfHost onClose={closePortal} /></Suspense>
      )}
      {portalOpen && portalMode === 'cloud' && (
        <Suspense fallback={null}>
          <Portal
            user={user} onUser={setUser} onClose={closePortal}
            onSelfHost={() => setPortalMode('local')}
          />
        </Suspense>
      )}
    </>
  )
}

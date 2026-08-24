import { useEffect, useState } from 'react'
import Board from './components/Board'
import Boundary from './components/Boundary'
import Compare from './components/Compare'
import CtaStrip from './components/CtaStrip'
import Dashboard from './components/Dashboard'
import Faq from './components/Faq'
import Footer from './components/Footer'
import Hero from './components/Hero'
import Integrations from './components/Integrations'
import Manifest from './components/Manifest'
import Nav from './components/Nav'
import Pricing from './components/Pricing'
import Stats from './components/Stats'

export default function App() {
  const [dashboardOpen, setDashboardOpen] = useState(false)

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

  return (
    <>
      {/* ambient backdrop */}
      <div className="ambient" aria-hidden="true">
        <div className="bloom bloom--1" />
        <div className="bloom bloom--2" />
        <div className="grain" />
      </div>

      <a className="skip" href="#main">Skip to content</a>

      <Nav onDashboard={() => setDashboardOpen(true)} />

      <main id="main">
        <Hero onDashboard={() => setDashboardOpen(true)} />
        <Stats />
        <Board />
        <Manifest />
        <Boundary />
        <Integrations />
        <Compare />
        <Pricing />
        <Faq />
        <CtaStrip onDashboard={() => setDashboardOpen(true)} />
      </main>

      <Footer />

      {dashboardOpen && <Dashboard onClose={() => setDashboardOpen(false)} />}
    </>
  )
}

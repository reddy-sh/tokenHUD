import { Component } from 'react'

/* A real React error boundary. The only one in the app.
 *
 * (Boundary.jsx, one directory up, is a marketing section about where the
 * product's data collection stops. Same word, unrelated job - this is the one
 * that catches a render that threw.)
 *
 * The dashboard renders a payload an agent produced on somebody else's machine
 * and a server handed over as JSON. Every panel already guards the fields it
 * reads, but "every panel, forever" is not a property anybody can hold: one
 * missing subtree, one string where a number was expected, one collector that
 * shipped a new shape before this build knew about it, and React unmounts the
 * whole tree - the rails, the topbar and the section switch included. The
 * person is then looking at a white page with no way to navigate off the panel
 * that broke, which is the one thing they need.
 *
 * So the boundary goes around the content area rather than around the app: the
 * chrome survives, and switching section is still possible, which is usually
 * enough to get back to a working board without a reload. `resetKey` is that
 * escape hatch - the shell passes the section, so navigating away clears a
 * caught error rather than leaving it stuck on screen.
 *
 * It deliberately shows what threw. This board is looked at by the person who
 * runs it, and a message they can paste into an issue is worth more to them
 * than a tidy apology that says nothing. */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  static getDerivedStateFromProps(props, state) {
    /* A new resetKey means the person navigated somewhere else; whatever threw
       is no longer on screen, so stop showing its message. */
    if (state.error && props.resetKey !== state.key) return { error: null, key: props.resetKey }
    if (state.key !== props.resetKey) return { key: props.resetKey }
    return null
  }

  componentDidCatch(error, info) {
    /* The console is where a browser bug report comes from, and the component
       stack is the half of it that names the panel. */
    console.error('[tokenhud] a panel failed to render', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="bv-wrap">
        <div className="bv-error">
          <h3>{this.props.title || 'This panel could not be drawn'}</h3>
          <p>
            The rest of the board is still here - the navigation on the left
            still works. Nothing was lost: the reading that caused this is on
            the server, not in this page.
          </p>
          <p className="bv-note">{error.message || String(error)}</p>
          <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
            <button className="btn btn--primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn btn--ghost" onClick={() => location.reload()}>
              Reload the board
            </button>
          </div>
        </div>
      </div>
    )
  }
}

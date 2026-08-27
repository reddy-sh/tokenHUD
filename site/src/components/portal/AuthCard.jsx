import {
    confirmResetPassword, confirmSignUp, resendSignUpCode, resetPassword, signIn, signInWithRedirect,
    signUp,
} from 'aws-amplify/auth'
import { useCallback, useState } from 'react'
import { cloudConfigured, googleConfigured } from '../../lib/cloud'

/* Email + password against Cognito, in the site's own clothes - the Amplify
   UI kit would drag its own design system in. Five small screens: sign in,
   create account, confirm the emailed code, and the two reset steps.
 *
 * Google is the sixth door and the only one that leaves the page: OAuth is a
 * redirect to Google and back through Cognito, so `signInWithRedirect` throws
 * this tab away and App.jsx picks up the session when it returns. It is hidden
 * rather than shown-and-broken on a deploy that has no Google client wired up,
 * because a button that fails with "no hosted UI domain" tells the person
 * pressing it nothing they can act on. */

const LINK = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--color-accent)', fontFamily: 'var(--font-body)', fontSize: 'var(--text-xs)',
}
const MUTED = { fontSize: 'var(--text-xs)', color: 'var(--color-ink-3)' }

/* Google's mark, drawn rather than fetched: the page is self-hosted down to
   its fonts, and a sign-in button is a poor place to start making requests to
   somebody else's CDN. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  )
}

function GoogleButton({ busy, onError }) {
  if (!googleConfigured) return null
  return (
    <>
      <button type="button" className="btn btn--ghost auth-google" disabled={busy}
        onClick={() => {
          /* No await and no try/catch around the happy path: this call
             navigates away, so there is nothing after it to run. A rejection
             means it never got that far. */
          signInWithRedirect({ provider: 'Google' }).catch(e => onError(e?.message || String(e)))
        }}>
        <GoogleMark />
        <span>Continue with Google</span>
      </button>
      <div className="auth-or" role="separator"><span>or</span></div>
    </>
  )
}

export default function AuthCard({ onClose, onSignedIn, onSelfHost }) {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async fn => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const finishSignIn = useCallback(result => {
    const step = result?.nextStep?.signInStep
    if (step === 'CONFIRM_SIGN_UP') {
      setNotice('This account still needs its email confirmed.')
      setMode('confirm')
      return
    }
    if (result?.isSignedIn) onSignedIn()
    else setError('Sign-in needs a step this portal does not support yet: ' + step)
  }, [onSignedIn])

  if (!cloudConfigured) {
    /* No Amplify backend - go straight to the self-host board. If onSelfHost
       is wired (App passes it), switch mode; otherwise the caller already
       rendered SelfHost directly and this branch is unreachable. */
    if (onSelfHost) { onSelfHost(); return null }
    return (
      <Card onClose={onClose} title="Portal not deployed">
        <p style={MUTED}>
          This build has no <code className="mono">amplify_outputs.json</code> - the Amplify backend
          (sign-in, machine registry, ingest endpoint) has not been deployed for it. Deploy the
          branch through Amplify Hosting, or run <code className="mono">npx ampx sandbox</code> at
          the repo root for a personal backend, then rebuild.
        </p>
      </Card>
    )
  }

  const emailField = (
    <input type="email" value={email} onChange={e => setEmail(e.target.value)}
      placeholder="you@example.com" aria-label="Email" autoComplete="email" autoFocus />
  )

  if (mode === 'signup') {
    return (
      <Card onClose={onClose} title="Create your account"
        sub="One account, all your machines. Free for one user on one machine - forever.">
        {error && <div className="bv-warnbar">{error}</div>}
        <GoogleButton busy={busy} onError={setError} />
        <form onSubmit={e => { e.preventDefault(); run(async () => {
          const r = await signUp({
            username: email.trim(),
            password,
            options: { userAttributes: { email: email.trim() } },
          })
          if (r.nextStep?.signUpStep === 'CONFIRM_SIGN_UP') { setNotice(null); setMode('confirm') }
          else finishSignIn(await signIn({ username: email.trim(), password }))
        }) }}>
          {emailField}
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" aria-label="Password" autoComplete="new-password" />
          <button className="btn btn--primary" type="submit" disabled={busy || !email.trim() || !password}>
            Create account <span aria-hidden="true">→</span>
          </button>
        </form>
        <p style={{ marginTop: 'var(--space-md)', ...MUTED }}>
          Already have one?{' '}
          <button style={LINK} onClick={() => { setError(null); setMode('signin') }}>Sign in</button>
        </p>
      </Card>
    )
  }

  if (mode === 'confirm') {
    return (
      <Card onClose={onClose} title="Check your email"
        sub={`A six-digit code went to ${email.trim() || 'your address'}.`}>
        {notice && <div className="bv-warnbar">{notice}</div>}
        {error && <div className="bv-warnbar">{error}</div>}
        <form onSubmit={e => { e.preventDefault(); run(async () => {
          await confirmSignUp({ username: email.trim(), confirmationCode: code.trim() })
          if (password) finishSignIn(await signIn({ username: email.trim(), password }))
          else { setNotice(null); setMode('signin') }
        }) }}>
          <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)}
            placeholder="Confirmation code" aria-label="Confirmation code" autoComplete="one-time-code" autoFocus />
          <button className="btn btn--primary" type="submit" disabled={busy || !code.trim()}>
            Confirm <span aria-hidden="true">→</span>
          </button>
        </form>
        <p style={{ marginTop: 'var(--space-md)', ...MUTED }}>
          Nothing arrived?{' '}
          <button style={LINK} disabled={busy}
            onClick={() => run(async () => { await resendSignUpCode({ username: email.trim() }); setNotice('Sent again.') })}>
            Send a new code
          </button>
        </p>
      </Card>
    )
  }

  if (mode === 'reset') {
    return (
      <Card onClose={onClose} title="Reset your password">
        {error && <div className="bv-warnbar">{error}</div>}
        <form onSubmit={e => { e.preventDefault(); run(async () => {
          await resetPassword({ username: email.trim() })
          setMode('reset2')
        }) }}>
          {emailField}
          <button className="btn btn--primary" type="submit" disabled={busy || !email.trim()}>
            Email me a code <span aria-hidden="true">→</span>
          </button>
        </form>
        <p style={{ marginTop: 'var(--space-md)', ...MUTED }}>
          <button style={LINK} onClick={() => { setError(null); setMode('signin') }}>Back to sign in</button>
        </p>
      </Card>
    )
  }

  if (mode === 'reset2') {
    return (
      <Card onClose={onClose} title="Choose a new password"
        sub={`The code went to ${email.trim() || 'your address'}.`}>
        {error && <div className="bv-warnbar">{error}</div>}
        <form onSubmit={e => { e.preventDefault(); run(async () => {
          await confirmResetPassword({
            username: email.trim(), confirmationCode: code.trim(), newPassword: password,
          })
          finishSignIn(await signIn({ username: email.trim(), password }))
        }) }}>
          <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)}
            placeholder="Code from the email" aria-label="Reset code" autoComplete="one-time-code" autoFocus />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="New password" aria-label="New password" autoComplete="new-password" />
          <button className="btn btn--primary" type="submit" disabled={busy || !code.trim() || !password}>
            Set password <span aria-hidden="true">→</span>
          </button>
        </form>
      </Card>
    )
  }

  return (
    <Card onClose={onClose} title="Sign in"
      sub="Your machines, your board - from anywhere.">
      {notice && <div className="bv-warnbar">{notice}</div>}
      {error && <div className="bv-warnbar">{error}</div>}
      <GoogleButton busy={busy} onError={setError} />
      <form onSubmit={e => { e.preventDefault(); run(async () => {
        finishSignIn(await signIn({ username: email.trim(), password }))
      }) }}>
        {emailField}
        <input type="password" value={password} onChange={e => setPassword(e.target.value)}
          placeholder="Password" aria-label="Password" autoComplete="current-password" />
        <button className="btn btn--primary" type="submit" disabled={busy || !email.trim() || !password}>
          Sign in <span aria-hidden="true">→</span>
        </button>
      </form>
      <p style={{ marginTop: 'var(--space-md)', display: 'flex', gap: 'var(--space-md)', justifyContent: 'center', ...MUTED }}>
        <button style={LINK} onClick={() => { setError(null); setMode('signup') }}>Create an account</button>
        <button style={LINK} onClick={() => { setError(null); setMode('reset') }}>Forgot password</button>
      </p>
      {onSelfHost && (
        <p style={{ marginTop: 'var(--space-sm)', textAlign: 'center', ...MUTED }}>
          or{' '}
          <button style={LINK} onClick={onSelfHost}>use a local server instead</button>
        </p>
      )}
    </Card>
  )
}

function Card({ title, sub, onClose, children }) {
  return (
    <div className="dashboard-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <button className="dashboard-close" onClick={onClose} aria-label="Close">×</button>
      <div className="dashboard-card">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
        {children}
      </div>
    </div>
  )
}

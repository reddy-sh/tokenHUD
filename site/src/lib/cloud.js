/* The portal's connection to the cloud backend.
 *
 * amplify_outputs.json is a deploy product written at the repo root by
 * `ampx pipeline-deploy` (or `ampx sandbox` during development). It is
 * loaded through a glob so a checkout that has never deployed still builds:
 * the portal then renders a "not deployed yet" notice instead of a form
 * that cannot work.
 *
 * Everything except sign-in goes over plain HTTP to one API — the same shape
 * the self-host board already uses against the Rust server, which is the point:
 * `SelfHost.jsx` fetches `/api/v1/overview` from a machine on your desk and
 * this fetches `/api/v1/overview` from api.tokenhud.com, and the board
 * components behind both cannot tell the difference. One client shape, two
 * backends, no GraphQL layer to keep in step with either.
 *
 * Amplify is still here for auth alone. `Amplify.configure` wires up the
 * Cognito pool; `fetchAuthSession` produces the ID token every call below
 * carries. Nothing imports `aws-amplify/data`.
 */
import { Amplify } from 'aws-amplify'
import { fetchAuthSession } from 'aws-amplify/auth'

const found = import.meta.glob('../../../amplify_outputs.json', { eager: true })
const outputs = Object.values(found)[0]?.default ?? null

export const cloudConfigured = outputs !== null

/* The API the agent enrolls against and heartbeats to, and the one this page
   reads. The agent strips a trailing slash itself, but the link we print
   should be clean. */
export const apiUrl = (outputs?.custom?.apiUrl ?? '').replace(/\/+$/, '')

/* Whether this build talks to a real domain or a sandbox's function URL.
   Shown in the portal so nobody has to work out which board they are on. */
export const apiDomain = outputs?.custom?.apiDomain ?? null

/* Whether Google is wired up on this deploy. The button is hidden rather than
   shown-and-broken when it is not: `signInWithRedirect` against a pool with no
   hosted-UI domain fails with an error nobody can act on. */
export const googleConfigured = Boolean(outputs?.auth?.oauth?.domain)

if (cloudConfigured) Amplify.configure(outputs)

/* An error carrying the status, because the callers care about the difference.
   409 on a handle means "taken", which is a thing to say next to the field;
   401 anywhere means the session went away while the tab was open. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function idToken() {
  const session = await fetchAuthSession()
  const token = session?.tokens?.idToken?.toString()
  if (!token) throw new ApiError(401, 'Your session has expired — sign in again.')
  return token
}

async function unwrap(res) {
  if (res.status === 204) return null
  let body = null
  try {
    body = await res.json()
  } catch {
    /* An empty or non-JSON body on an error is still an error; on a success it
       is a route that returns nothing, and null is the right answer. */
  }
  if (!res.ok) throw new ApiError(res.status, body?.error || `${res.status} ${res.statusText}`)
  return body
}

/* A signed-in call. The ID token is fetched per request rather than held,
   because Amplify refreshes it in the background and a copy taken when the
   portal opened would be stale by the time somebody comes back to the tab. */
export async function api(path, { method = 'GET', body, signal } = {}) {
  if (!apiUrl) throw new ApiError(0, 'This build has no cloud backend configured.')
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    signal,
    headers: {
      authorization: `Bearer ${await idToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return unwrap(res)
}

/* A call with no credential at all — the public leaderboard, and only that.
   It is deliberately a separate function: a route that can be read without
   signing in should have to say so in the code that reads it. */
export async function apiPublic(path, { signal, base = apiUrl } = {}) {
  if (!base) throw new ApiError(0, 'This build has no cloud backend configured.')
  return unwrap(await fetch(`${base}${path}`, { signal }))
}

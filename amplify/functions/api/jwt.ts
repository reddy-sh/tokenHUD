// Who is asking, on the routes a browser calls.
//
// The portal signs in against Cognito and sends the resulting ID token as a
// bearer credential. This verifies it the only way worth doing: the signature
// against the user pool's published JWKS, plus issuer, audience, token use and
// expiry. Nothing here trusts a claim before the signature is checked, and
// nothing decodes a token it has not verified.
//
// aws-jwt-verify fetches the JWKS once and caches it for the life of the
// execution environment, so a warm invocation costs no network call. The
// verifier is built at module scope for the same reason.

import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID as string,
  clientId: process.env.USER_POOL_CLIENT_ID as string,
  // The ID token, not the access token: the portal needs `sub` and `email`,
  // and the access token carries scopes this API does not use.
  tokenUse: 'id',
});

export type Caller = { sub: string; email: string | null };

/* The signed-in account behind a request, or null.
 *
 * Null covers every way a caller can fail to be signed in — no header, a
 * malformed one, an expired token, a token minted for another pool — because
 * the answer to all of them is the same 401, and telling them apart would tell
 * an attacker which of their guesses was closer. */
export async function callerOf(headers: Record<string, string | undefined>): Promise<Caller | null> {
  const raw = headers?.authorization ?? headers?.Authorization;
  if (typeof raw !== 'string') return null;
  const [scheme, token] = raw.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  try {
    const payload = await verifier.verify(token.trim());
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  } catch {
    return null;
  }
}

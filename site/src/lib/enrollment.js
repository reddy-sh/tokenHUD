/* Minting an enrollment link, browser-side.
 *
 * The portal generates the one-shot token and stores only its SHA-256 —
 * the same discipline as the self-host server, where no secret survives in
 * the store. The raw token exists in exactly two places: the command shown
 * once in the register modal, and the agent's memory while it enrolls.
 *
 * The pairing code derivation must match both server/src/board.rs and the
 * ingest function: sha256("tokenhud-pair:" + token), first six bytes each
 * taken modulo the alphabet, which drops 0/O/1/I/L/U, shown as XXX-XXX. The
 * terminal prints what the cloud sends back; the portal derives it locally;
 * a human eye-matches the two. */

const te = new TextEncoder()

export async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(s))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/* 32 random bytes, base64url without padding — the 43-character shape the
   server mints and the agent's claim endpoint validates (20–100 chars). */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

export async function pairingCode(token) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(`tokenhud-pair:${token}`)))
  let code = ''
  for (let i = 0; i < 6; i++) code += PAIR_ALPHABET[digest[i] % PAIR_ALPHABET.length]
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

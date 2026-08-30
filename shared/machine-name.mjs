/* How a machine gets its name.
 *
 * A board is only useful if you can tell one row from another, and the old
 * default could not: the browser sent the literal string "machine" for every
 * registration, so the server's collision suffix did the naming and a fleet
 * came out as "machine", "machine · 2", "machine · 11". Those names say
 * nothing about whose machine it is, which machine it is, or which of two
 * identical laptops you are looking at.
 *
 * The shape is `<first>-<host>-<uid>`, and each part earns its place:
 *
 *   first  the owner's first name, from their sign-in email. On a shared or
 *          team board this is the part that says whose laptop this is.
 *   host   the machine's own hostname, slugged. This is the part a human
 *          recognises — it is the same string they see in their shell prompt.
 *   uid    six random characters. Two people really do own two machines both
 *          called `mbp`, and a name that collides is a name that gets a " · 2"
 *          bolted onto it, which is where this started.
 *
 * The pieces arrive at different times, which is the whole reason this module
 * is shared rather than inlined. `first` and `uid` are known in the browser at
 * registration; `host` is not known until the agent enrols and reports it. The
 * name is therefore built twice — provisionally at registration, finally at
 * enrolment — and both callers have to agree on the rules or the machine
 * appears to rename itself for no reason.
 */

/* DynamoDB is happy with far more, but `str(req?.label, 120)` in the ingest
   handler is the real ceiling and the rename endpoint enforces the same. */
export const MAX_LABEL = 120;

/* No vowels beyond `a`, no `0/O/1/I/L/U` — the same instinct as the pairing
   alphabet. A name that gets read aloud over a desk should not turn on
   whether that character was a one or an ell. */
const UID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789';
const UID_LEN = 6;

/* Lowercase, alphanumeric, single dashes, no leading or trailing dash. Applied
   to every part so the joined name has exactly one kind of separator and the
   whole thing survives a URL, a filename and a shell word unquoted. */
function slug(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* The owner's first name, from the address they signed in with.
 *
 * `sankara.telukutla@gmail.com` and `sankara@reddy.sh` both give `sankara`.
 * Plus-addressing is cut before the split so `sankara+work@…` does not become
 * `sankara-work`. An address that yields nothing usable — a UUID alias, a
 * digits-only local part — falls back rather than producing a name that is
 * somehow worse than no name at all. */
export function firstNameFrom(email, fallback = 'user') {
  const local = String(email ?? '').split('@')[0].split('+')[0];
  const first = slug(local).split('-').filter(Boolean)[0] ?? '';
  // A purely numeric "first name" is an alias, not a person.
  if (!first || /^[0-9]+$/.test(first)) return fallback;
  return first;
}

/* The machine's own name, as a human would recognise it.
 *
 * Hostnames arrive dressed for a network, not for a list: `Sankaras-MacBook-
 * Pro.local`, `web-01.prod.internal`. The first label is the part that
 * identifies the machine and the rest identifies the network it happened to
 * be on when it enrolled — which can change without the machine changing. */
export function hostSlug(hostname, fallback = 'machine') {
  const firstLabel = String(hostname ?? '').trim().split('.')[0];
  return slug(firstLabel) || fallback;
}

/* Six characters of collision insurance.
 *
 * Takes an optional source of randomness so a caller with one already — the
 * browser's crypto, the Lambda's — does not have to reach for Math.random,
 * and so the tests can be deterministic. */
export function shortUid(randomBytes) {
  const bytes = randomBytes
    ? randomBytes(UID_LEN)
    : globalThis.crypto?.getRandomValues?.(new Uint8Array(UID_LEN));
  if (!bytes) throw new Error('shortUid needs a source of randomness');
  let out = '';
  for (let i = 0; i < UID_LEN; i++) out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
  return out;
}

/* Assemble `<first>-<host>-<uid>`, within the length ceiling.
 *
 * When the whole thing is too long it is the host that gives way, never the
 * uid: the uid is what makes the name unique, and a truncated uid is a name
 * that can collide again. `first` is short by construction, so in practice
 * this only ever bites a machine with a genuinely enormous hostname. */
export function machineName({ email, first: given, hostname, uid, fallbackFirst, fallbackHost } = {}) {
  // `first` wins over `email` because the two callers know different things.
  // The browser and the register handler hold the signed-in address; the
  // enrol handler does not — it is answering an agent, not a person — and
  // reads back the first name that registration stamped on the machine.
  const first = slug(given) || firstNameFrom(email, fallbackFirst ?? 'user');
  const host = hostSlug(hostname, fallbackHost ?? 'machine');
  const tail = uid ? `-${uid}` : '';
  const room = MAX_LABEL - first.length - 1 - tail.length;
  const clipped = host.length > room ? host.slice(0, Math.max(1, room)).replace(/-+$/, '') : host;
  return `${first}-${clipped}${tail}`;
}

/* Is this name one we generated, rather than one a person typed?
 *
 * Only auto-generated names get rewritten when the hostname finally arrives.
 * Somebody who took the trouble to call a machine "build box" should find it
 * still called that after the agent enrols. The stored `labelAuto` flag is the
 * authority; this is the fallback for rows written before the flag existed,
 * including the "machine · 11" generation that prompted all of this. */
export function looksGenerated(label) {
  const s = String(label ?? '').trim();
  if (!s) return true;
  if (/^machine(\s·\s\d+)?$/.test(s)) return true;
  return new RegExp(`^[a-z0-9]+-[a-z0-9-]+-[${UID_ALPHABET}]{${UID_LEN}}$`).test(s);
}

/* The part of a generated name that actually distinguishes one machine.
 *
 * Every machine on one board shares the same `<first>-` prefix and carries a
 * uid that exists for the database's benefit rather than the reader's, so a
 * list of them is a column of near-identical strings differing in the middle —
 * the worst possible shape to scan. In a tight space, show the middle. The
 * full name still belongs in a tooltip, and anywhere there is room for it.
 *
 * A name a person typed is returned untouched: they chose those words. */
export function shortMachineName(label) {
  const s = String(label ?? '').trim();
  if (!looksGenerated(s)) return s;
  const parts = s.split('-');
  // <first>-<host…>-<uid>: drop the ends, keep everything between them.
  if (parts.length >= 3) {
    const middle = parts.slice(1, -1).join('-');
    if (middle) return middle;
  }
  return s;
}

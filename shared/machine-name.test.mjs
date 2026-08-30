import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_LABEL, firstNameFrom, hostSlug, looksGenerated, machineName, shortMachineName, shortUid,
} from './machine-name.mjs';

/* A deterministic stand-in for the CSPRNG, so a uid can be asserted on. */
const bytes = (...vals) => (n) => Uint8Array.from({ length: n }, (_, i) => vals[i % vals.length]);

test('the first name is the human part of an email address', () => {
  assert.equal(firstNameFrom('sankara@reddy.sh'), 'sankara');
  assert.equal(firstNameFrom('sankara.telukutla@gmail.com'), 'sankara');
  assert.equal(firstNameFrom('Sankara.Telukutla@GMAIL.com'), 'sankara');
  assert.equal(firstNameFrom('sankara_telukutla@corp.io'), 'sankara');
  assert.equal(firstNameFrom('sankara-t@corp.io'), 'sankara');
});

test('plus-addressing names the person, not the tag they filed it under', () => {
  assert.equal(firstNameFrom('sankara+tokenhud@gmail.com'), 'sankara');
  assert.equal(firstNameFrom('sankara.t+ci@gmail.com'), 'sankara');
});

test('an address with no human part falls back rather than inventing one', () => {
  assert.equal(firstNameFrom(''), 'user');
  assert.equal(firstNameFrom(null), 'user');
  assert.equal(firstNameFrom(undefined), 'user');
  // A numeric alias is an identifier, not a name.
  assert.equal(firstNameFrom('12345@relay.example'), 'user');
  assert.equal(firstNameFrom('!!!@example.com'), 'user');
});

test('the hostname keeps the machine and drops the network', () => {
  assert.equal(hostSlug('Sankaras-MacBook-Pro.local'), 'sankaras-macbook-pro');
  assert.equal(hostSlug('web-01.prod.internal'), 'web-01');
  assert.equal(hostSlug('MBP'), 'mbp');
  assert.equal(hostSlug('  spaced name  '), 'spaced-name');
});

test('an unusable hostname falls back instead of producing an empty part', () => {
  assert.equal(hostSlug(''), 'machine');
  assert.equal(hostSlug('...'), 'machine');
  assert.equal(hostSlug(null), 'machine');
  assert.equal(hostSlug('', 'pending'), 'pending');
});

test('the uid avoids the characters people misread aloud', () => {
  const uid = shortUid(bytes(0, 1, 2, 3, 4, 5));
  assert.equal(uid.length, 6);
  assert.match(uid, /^[a-z0-9]{6}$/);
  assert.ok(!/[01ilou]/.test(uid), `${uid} contains an ambiguous character`);
});

test('the assembled name is first, host and uid', () => {
  assert.equal(
    machineName({ email: 'sankara@reddy.sh', hostname: 'Sankaras-MacBook-Pro.local', uid: 'k3f9dq' }),
    'sankara-sankaras-macbook-pro-k3f9dq',
  );
});

test('a precomputed first name wins over the email', () => {
  // This is the enrol handler's case: it holds `ownerFirst` off the machine
  // record and has no address to derive one from.
  assert.equal(
    machineName({ first: 'sankara', hostname: 'mbp', uid: 'k3f9dq' }),
    'sankara-mbp-k3f9dq',
  );
  assert.equal(
    machineName({ first: 'Sankara', email: 'someone.else@corp.io', hostname: 'mbp', uid: 'k3f9dq' }),
    'sankara-mbp-k3f9dq',
  );
});

test('the provisional name says it is waiting for a hostname', () => {
  assert.equal(
    machineName({ email: 'sankara@reddy.sh', uid: 'k3f9dq', fallbackHost: 'pending' }),
    'sankara-pending-k3f9dq',
  );
});

test('an enormous hostname is clipped, and the uid always survives', () => {
  const name = machineName({
    email: 'sankara@reddy.sh', hostname: 'x'.repeat(400), uid: 'k3f9dq',
  });
  assert.ok(name.length <= MAX_LABEL, `${name.length} > ${MAX_LABEL}`);
  assert.ok(name.startsWith('sankara-'));
  assert.ok(name.endsWith('-k3f9dq'), 'the unique part is what makes the name unique');
});

test('generated names are recognised, typed ones are left alone', () => {
  // The shapes this replaces, which must still be treated as unnamed.
  assert.equal(looksGenerated('machine'), true);
  assert.equal(looksGenerated('machine · 2'), true);
  assert.equal(looksGenerated('machine · 11'), true);
  assert.equal(looksGenerated(''), true);
  assert.equal(looksGenerated(null), true);
  // Its own output.
  assert.equal(looksGenerated('sankara-sankaras-macbook-pro-k3f9dq'), true);
  assert.equal(looksGenerated('sankara-pending-k3f9dq'), true);
  // A name a person chose, which enrolment must never overwrite.
  assert.equal(looksGenerated('build box'), false);
  assert.equal(looksGenerated('Ada’s laptop'), false);
  assert.equal(looksGenerated('prod-runner'), false);
});

test('the short form keeps the part that distinguishes one machine', () => {
  assert.equal(shortMachineName('sankara-sankaras-macbook-pro-k3f9dq'), 'sankaras-macbook-pro');
  assert.equal(shortMachineName('sankara-web-01-k3f9dq'), 'web-01');
  assert.equal(shortMachineName('sankara-pending-k3f9dq'), 'pending');
});

test('the short form leaves a name a person typed alone', () => {
  assert.equal(shortMachineName('build box'), 'build box');
  assert.equal(shortMachineName('prod-runner'), 'prod-runner');
  // Nothing to shorten, and nothing to lose.
  assert.equal(shortMachineName('machine · 11'), 'machine · 11');
  assert.equal(shortMachineName(''), '');
});

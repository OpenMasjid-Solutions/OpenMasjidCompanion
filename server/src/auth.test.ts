// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The session token is the only thing standing between the internet and this masjid's admin
 * panel — the app is published on a public hostname through the tunnel. Every property below
 * is one an attacker would otherwise get for free.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { COOKIE, MAX_AGE_MS, SSO_SESSION_MS, cookieOptions, hashPassword, makeToken, secureForRequest, tokenUser, verifyPassword, verifyToken } from './auth';

const secret = crypto.randomBytes(32);
const other = crypto.randomBytes(32);

test('a password round-trips, and a wrong one does not', () => {
  const cred = hashPassword('a decent masjid password');
  assert.ok(verifyPassword('a decent masjid password', cred));
  assert.ok(!verifyPassword('a decent masjid passwore', cred));
  assert.ok(!verifyPassword('', cred));
});

test('the same password hashes differently every time (a per-credential salt)', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a.hash, b.hash, 'two identical passwords must not share a digest');
  assert.notEqual(a.salt, b.salt);
  assert.ok(verifyPassword('same', a) && verifyPassword('same', b));
});

test('the scrypt cost is stored WITH the hash, so it can be raised without locking anyone out', () => {
  const cred = hashPassword('x');
  assert.equal(cred.n, 2 ** 16, 'new hashes use the hardened cost');
  // Simulate a credential written by an older build at Node's default cost. It must still
  // verify — otherwise raising the cost signs out every existing admin.
  const legacy = { ...hashPassword('x'), n: 16384 };
  const dk = crypto.scryptSync('x', Buffer.from(legacy.salt, 'hex'), 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  legacy.hash = dk.toString('hex');
  assert.ok(verifyPassword('x', legacy), 'a hash made at the old cost must still verify');
});

test('verifyPassword never throws on a malformed credential', () => {
  // A corrupted row on the data volume must degrade to "wrong password", not a 500 on the
  // login route — which would be indistinguishable from the app being broken.
  for (const cred of [
    { hash: 'not-hex', salt: 'zz', n: 16384 },
    { hash: '', salt: '', n: 16384 },
    { hash: 'ab', salt: 'cd', n: -1 },
  ]) {
    assert.equal(verifyPassword('x', cred as never), false);
  }
});

test('a token verifies with its own secret and nothing else', () => {
  const t = makeToken(secret);
  assert.ok(verifyToken(secret, t));
  assert.ok(!verifyToken(other, t), 'another volume\'s key must not validate our token');
});

test('a tampered payload or signature is refused', () => {
  const t = makeToken(secret);
  const [payload, sig] = t.split('.');
  assert.ok(!verifyToken(secret, `${payload}x.${sig}`), 'payload edited');
  assert.ok(!verifyToken(secret, `${payload}.${sig}x`), 'signature edited');
  assert.ok(!verifyToken(secret, payload), 'signature removed entirely');
  assert.ok(!verifyToken(secret, ''), 'empty');
  assert.ok(!verifyToken(secret, undefined));
  // The forge that matters: a payload the attacker WROTE, with a far-future expiry.
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e12, aud: 'admin' })).toString('base64url');
  assert.ok(!verifyToken(secret, `${forged}.`), 'unsigned claims must not be accepted');
});

test('an expired token is refused', () => {
  assert.ok(!verifyToken(secret, makeToken(secret, -1)), 'already expired');
  assert.ok(verifyToken(secret, makeToken(secret, 5_000)), 'still valid');
});

test('the audience is checked, so a token minted elsewhere cannot be replayed here', () => {
  const t = makeToken(secret, MAX_AGE_MS, 'admin');
  assert.ok(verifyToken(secret, t, 'admin'));
  assert.ok(!verifyToken(secret, t, 'other' as never));
});

test('tokenUser reads the name only from a VALID token', () => {
  const t = makeToken(secret, MAX_AGE_MS, 'admin', 'Hasan');
  assert.equal(tokenUser(secret, t), 'Hasan');
  // The whole point: an attacker who writes their own payload must not get a name out of it.
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e12, aud: 'admin', usr: 'Administrator' })).toString('base64url');
  assert.equal(tokenUser(secret, `${forged}.deadbeef`), '', 'unsigned name must not be read');
  assert.equal(tokenUser(other, t), '', 'wrong key');
  assert.equal(tokenUser(secret, makeToken(secret, -1, 'admin', 'Hasan')), '', 'expired');
});

test('a username is capped, so a hostile platform response cannot bloat every cookie', () => {
  const t = makeToken(secret, MAX_AGE_MS, 'admin', 'x'.repeat(500));
  assert.equal(tokenUser(secret, t).length, 120);
});

test('an SSO session is much shorter than a password session', () => {
  // The platform's answer is a snapshot. An admin who signs out of the dashboard must not
  // stay signed in here for a month on the strength of one 45-second-old yes.
  assert.ok(SSO_SESSION_MS < MAX_AGE_MS);
  assert.equal(SSO_SESSION_MS, 60 * 60 * 1000);
  assert.equal(MAX_AGE_MS, 30 * 24 * 3600 * 1000);
});

test('the cookie is HttpOnly, SameSite=Lax and scoped to the whole origin', () => {
  const o = cookieOptions(MAX_AGE_MS, false);
  assert.equal(o.httpOnly, true, 'script must never be able to read the session');
  assert.equal(o.sameSite, 'lax');
  // Path '/' and NOT the base path: behind the tunnel the browser sees us under /companion,
  // on the LAN at the root, and the same browser may hit both. Scoping to a prefix would drop
  // the session on whichever form it was not minted under.
  assert.equal(o.path, '/');
  assert.equal(o.maxAge, MAX_AGE_MS / 1000);
});

test('Secure follows the scheme the request actually arrived on', () => {
  // Always-Secure would lock every standalone LAN admin out of their own panel; never-Secure
  // would let a 30-day admin token ride a plaintext request to a public hostname.
  assert.equal(secureForRequest({ protocol: 'http', headers: {} }), false, 'plain LAN');
  assert.equal(secureForRequest({ protocol: 'https', headers: {} }), true, 'direct TLS');
  assert.equal(secureForRequest({ protocol: 'http', headers: { 'x-forwarded-proto': 'https' } }), true, 'behind the tunnel');
  assert.equal(secureForRequest({ protocol: 'http', headers: { 'x-forwarded-proto': 'https, http' } }), true, 'proxy chain: the client-facing hop wins');
  assert.equal(secureForRequest({ protocol: 'http', headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(secureForRequest({ protocol: 'http', headers: { 'x-forwarded-proto': ['https'] } }), true, 'repeated header');
});

test('the cookie name is the one the web and the server both expect', () => {
  // Renaming this silently signs out every admin on a masjid's box at update time.
  assert.equal(COOKIE, 'omc_session');
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the masjid may store as a way of being reached.
 *
 * The server's half of a check the browser also does. That duplication is deliberate and is
 * written down in both files: the data volume outlives any one build, so a value written by a
 * looser version has to be refused again on the way out, and the page must never be the only
 * place a bad URL was going to be caught.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import { ContactSchema, EMPTY_CONTACT, SOCIALS, coerceUrl, getContact, hasAnyContact, safeUrl, setContact } from './contact';

function freshStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'omc-contact-')));
}

test('ONLY http AND https SURVIVE', () => {
  assert.equal(safeUrl('https://masjid.example.org/'), 'https://masjid.example.org/');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl('file:///etc/passwd'), '');
  assert.equal(safeUrl(''), '');
  assert.equal(safeUrl('x'.repeat(400)), '', 'and a URL longer than any real one is refused');
});

test('A BARE DOMAIN IS ACCEPTED, because that is what people type', () => {
  // Refusing "masjid.org" would be a form saying "invalid" at a perfectly good answer, and the
  // person filling it in is a volunteer, not a developer.
  assert.equal(coerceUrl('masjid.example.org'), 'https://masjid.example.org/');
  assert.equal(coerceUrl('www.masjid.example.org/about'), 'https://www.masjid.example.org/about');
  assert.equal(coerceUrl('  masjid.example.org  '), 'https://masjid.example.org/');
  // But it does not turn a refused scheme into an accepted one by prefixing it.
  assert.equal(coerceUrl('javascript:alert(1)'), '');
  assert.equal(coerceUrl(''), '');
});

test('everything is optional, and an empty form is a valid one', () => {
  const parsed = ContactSchema.safeParse({});
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, EMPTY_CONTACT);
  assert.equal(hasAnyContact(parsed.data), false);
});

test('an email is checked loosely, and a wrong one is a refusal rather than a silent drop', () => {
  // Loosely on purpose: a strict address grammar rejects real addresses. The worst case of a
  // wrong one here is a mail app opening with a typo in it.
  assert.ok(ContactSchema.safeParse({ email: 'imam@masjid.example' }).success);
  assert.ok(!ContactSchema.safeParse({ email: 'not an email' }).success);
  assert.ok(ContactSchema.safeParse({ email: '' }).success, 'blank is not wrong, it is absent');
});

test('a bad link is emptied rather than rejecting the whole form', () => {
  // The phone number and the address a masjid just typed must not be thrown away because one
  // of six social boxes had a typo in it. The bad field becomes '' and simply is not shown.
  const parsed = ContactSchema.safeParse({ phone: '020 7946 0000', instagram: 'javascript:alert(1)' });
  assert.ok(parsed.success);
  assert.equal(parsed.data.phone, '020 7946 0000');
  assert.equal(parsed.data.instagram, '');
});

test('an address keeps its lines and loses its ragged spacing', () => {
  const parsed = ContactSchema.parse({ address: '12  Example   Road\nLondon\nE1 1AA' });
  assert.equal(parsed.address, '12 Example Road\nLondon\nE1 1AA');
});

test('READING IS PARSED TOO, so a row from an older build cannot reach a page', () => {
  // The point of the whole file. A build with looser rules could have written this; the reader
  // has to be the one that refuses it, because it is the reader that is still running.
  const store = freshStore();
  store.setJson('masjid.contact', { phone: '020 7946 0000', website: 'javascript:alert(1)', instagram: 42 });
  const c = getContact(store);
  assert.equal(c.phone, '020 7946 0000');
  assert.equal(c.website, '', 'refused on the way out, not only on the way in');
  assert.equal(c.instagram, '', 'and a value of the wrong type does not crash the read');
  store.close();
});

test('a corrupt row degrades to nothing to show, not to a broken page', () => {
  const store = freshStore();
  store.set('masjid.contact', 'not json at all');
  assert.deepEqual(getContact(store), EMPTY_CONTACT);
  store.close();
});

test('what goes in comes out', () => {
  const store = freshStore();
  const c = ContactSchema.parse({ phone: '020 7946 0000', website: 'masjid.example.org', whatsapp: 'https://chat.whatsapp.com/abc' });
  setContact(store, c);
  const back = getContact(store);
  assert.equal(back.phone, '020 7946 0000');
  assert.equal(back.website, 'https://masjid.example.org/');
  assert.equal(back.whatsapp, 'https://chat.whatsapp.com/abc');
  assert.equal(hasAnyContact(back), true);
  store.close();
});

test('the network list matches the browser half exactly', () => {
  // Two lists in two languages again: this decides what may be stored and `web/src/contactLinks.ts`
  // decides what is drawn. A network only one of them knows is either an unstorable form field
  // or an unlabelled chip.
  const web = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'contactLinks.ts'), 'utf8');
  const m = web.match(/export const SOCIALS = \[([^\]]+)\]/);
  assert.ok(m, 'web/src/contactLinks.ts no longer declares SOCIALS');
  const theirs = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(theirs, [...SOCIALS], 'the network lists have drifted');
});

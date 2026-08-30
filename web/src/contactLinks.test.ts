// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What may become an `href` on a page a stranger opens.
 *
 * These values are typed into a form by a masjid volunteer, which makes them less hostile than
 * the campaign JSON this app pulls from another app — and not trustworthy, because they are
 * still text that ends up inside a link somebody taps on their own phone. The server checks the
 * same things on the way in; this is the second of two checks, deliberately, because the volume
 * outlives any one build and a value a looser version once accepted must not be caught for the
 * first time by the browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SOCIALS, hasContact, mailHref, mapsHref, safeUrl, socialsOf, telHref, type Contact } from './contactLinks';

const blank: Contact = {
  phone: '',
  email: '',
  address: '',
  website: '',
  whatsapp: '',
  instagram: '',
  facebook: '',
  x: '',
  youtube: '',
  telegram: '',
};

test('ONLY http AND https EVER BECOME A LINK', () => {
  assert.equal(safeUrl('https://masjid.example.org/'), 'https://masjid.example.org/');
  assert.equal(safeUrl('http://masjid.example.org/'), 'http://masjid.example.org/');
  // The obvious one, and the less obvious ones — a scheme that looks harmless still reaches
  // whatever the phone has registered for it.
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(safeUrl('file:///etc/passwd'), '');
  assert.equal(safeUrl('blob:https://x/y'), '');
  assert.equal(safeUrl('  JavaScript:alert(1)  '), '', 'and case and whitespace do not get round it');
  assert.equal(safeUrl('not a url at all'), '');
  assert.equal(safeUrl(''), '');
});

test('the number shown is what was typed; the number DIALLED is what a dialler can use', () => {
  // A masjid writes "+44 (0)20 7946 0000". That is what somebody recognises, so it stays on
  // screen — but a `tel:` with brackets in it is a URL with brackets in it.
  assert.equal(telHref('+44 (0)20 7946 0000'), 'tel:+442079460000');
  assert.equal(telHref('020 7946 0000'), 'tel:02079460000');
  assert.equal(telHref('  '), '');
  assert.equal(telHref('ext. two'), '', 'nothing to dial is no link, not "tel:"');
});

test('THE LEADING + SURVIVES, because dropping it breaks the international case', () => {
  // The one case where a missing character makes the number reach nobody, and the one case
  // where a masjid's number is most likely to be dialled from abroad.
  assert.ok(telHref('+1 555 123 4567').startsWith('tel:+1'));
  assert.ok(!telHref('1 555 123 4567').startsWith('tel:+'));
});

test('a mailto cannot carry a header injection', () => {
  assert.equal(mailHref('imam@masjid.example'), 'mailto:imam%40masjid.example');
  // A newline in a mailto is how a Bcc gets added to whatever mail app opens it.
  assert.equal(mailHref('a@b.co\nbcc:everyone@x.co'), '');
  assert.equal(mailHref('"weird"@b.co'), '');
  assert.equal(mailHref('a@b.co>'), '');
  assert.equal(mailHref('not an email'), '');
});

test('directions are a search, not a pin', () => {
  // What is stored is text somebody typed, not a coordinate. Handing it to a map's own search
  // degrades to "roughly the right street"; pretending it is a coordinate degrades to the sea.
  const href = mapsHref('12 Example Road\nLondon\nE1 1AA');
  assert.match(href, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(href, /Example%20Road/);
  assert.ok(!href.includes('\n'), 'the newlines are collapsed, not encoded into the URL raw');
  assert.equal(mapsHref('   '), '');
});

test('a link this app will not render is not counted as one it has', () => {
  // `hasContact` decides whether the card is drawn at all. Counting a `javascript:` URL would
  // draw an empty card headed with the masjid's name, which looks like something failed to load.
  assert.equal(hasContact({ ...blank }), false);
  assert.equal(hasContact({ ...blank, website: 'javascript:alert(1)' }), false);
  assert.equal(hasContact({ ...blank, phone: 'call us' }), false, 'nothing to dial');
  assert.equal(hasContact({ ...blank, phone: '020 7946 0000' }), true);
  assert.equal(hasContact({ ...blank, address: '12 Example Road' }), true);
  assert.equal(hasContact({ ...blank, instagram: 'https://instagram.com/x' }), true);
  assert.equal(hasContact(null), false);
});

test('ONLY THE LINKS THAT WERE SET ARE DRAWN, in a fixed order', () => {
  // The whole shape of the feature: a masjid with one link gets one chip. The order is the
  // declaration order rather than the order they were filled in, so it does not shuffle between
  // two masjids or between two saves.
  const c: Contact = { ...blank, youtube: 'https://youtube.com/@x', whatsapp: 'https://chat.whatsapp.com/x' };
  assert.deepEqual(socialsOf(c).map((s) => s.id), ['whatsapp', 'youtube']);
  assert.deepEqual(socialsOf(blank), []);
  // And a bad one is dropped rather than drawn as a dead chip.
  assert.deepEqual(socialsOf({ ...blank, facebook: 'javascript:x' }), []);
});

test('every network in the list is one the card can label', () => {
  // SOCIALS drives both halves; a value here with no label or no icon would render as a blank
  // chip somebody is invited to tap.
  assert.deepEqual([...SOCIALS], ['whatsapp', 'instagram', 'facebook', 'x', 'youtube', 'telegram']);
});

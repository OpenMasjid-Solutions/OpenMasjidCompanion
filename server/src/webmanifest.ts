// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * webmanifest.ts — the file that decides what this app is called and looks like once it is on
 * someone's phone.
 *
 * **Generated per request, never a static file** (CLAUDE.md §10), because every field in it is
 * dynamic. The name comes from a setting the admin can change; `start_url` and `scope` come
 * from the tunnel path the admin chose and can rename; the language and direction follow the
 * masjid's own timetable. A static manifest would be wrong for every masjid but the first.
 *
 * The name is the point. A musalli who installs this sees **their masjid** on the home screen,
 * beside their bank and their messages — not the name of the software that put it there.
 */

export interface ManifestInput {
  /** The admin's chosen App name, if they set one. */
  appName: string;
  /** The masjid's name from the timetable, used when no App name is set. */
  masjidName: string;
  /** The path prefix this app is served under: '' or '/companion'. */
  basePath: string;
  /** BCP-47, from the timetable's own language setting. */
  lang: string;
  theme: string;
  background: string;
}

/** Right-to-left scripts. The manifest's `dir` affects how the name is rendered in the
 *  installer and on the home screen, which is the one piece of this app's text that lives
 *  outside our own CSS and cannot be fixed with logical properties. */
const RTL = new Set(['ar', 'ur', 'fa', 'he', 'ps', 'sd', 'ug', 'yi', 'ku', 'dv']);

export function isRtl(lang: string): boolean {
  return RTL.has((lang || '').toLowerCase().split('-')[0]);
}

/**
 * A short name that survives being put under an icon.
 *
 * Home screens give a label about 12 characters before truncating, and "Masjid" at the front of
 * a name is the least informative part when every masjid nearby starts the same way. So a long
 * name loses that prefix first, and is only then cut — "Masjid An-Noor" becomes "An-Noor"
 * rather than "Masjid An…".
 */
export function shortName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 12) return trimmed;
  const withoutPrefix = trimmed.replace(/^(masjid|mosque|islamic centre|islamic center|jamia|jame)\s+/i, '');
  const best = withoutPrefix.length <= 12 && withoutPrefix.length > 0 ? withoutPrefix : trimmed;
  if (best.length <= 12) return best;
  // Cut on a word boundary if there is one near the limit, rather than mid-word.
  const cut = best.slice(0, 12);
  const space = cut.lastIndexOf(' ');
  return (space >= 8 ? cut.slice(0, space) : cut).trim();
}

/** The name to install under: the admin's setting, else the masjid's own name, else something
 *  honest and generic. Never "OpenMasjid Companion" — that is the software's name, not the
 *  masjid's, and it is not what should be under the icon. */
export function installName(appName: string, masjidName: string): string {
  return (appName || '').trim() || (masjidName || '').trim() || 'Masjid Companion';
}

export function buildManifest(input: ManifestInput): Record<string, unknown> {
  const base = input.basePath || '';
  const name = installName(input.appName, input.masjidName);
  const lang = input.lang || 'en';

  return {
    name,
    short_name: shortName(name),
    // Both scoped to the base path, which is what keeps an installed app inside THIS app rather
    // than wandering into whatever else the masjid serves on the same domain.
    start_url: `${base}/`,
    scope: `${base}/`,
    id: `${base}/`,
    display: 'standalone',
    orientation: 'portrait',
    lang,
    dir: isRtl(lang) ? 'rtl' : 'ltr',
    theme_color: input.theme,
    background_color: input.background,
    categories: ['lifestyle'],
    icons: [
      { src: `${base}/api/public/icon/192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/api/public/icon/512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      // A maskable icon is padded into the middle 80% so a launcher can crop it to a circle or
      // a squircle without slicing the masjid's name off — see png.ts.
      { src: `${base}/api/public/icon/maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Per-browser presentation preferences (theme, wallpaper, accent), persisted in
 * localStorage and applied live.
 *
 * This is NOT masjid configuration. It mirrors how OpenMasjidOS treats appearance, so the
 * app follows the viewer's own light/dark setting and, when the admin opens it from the
 * dashboard, inherits the dashboard's look through the Fabric.
 *
 * The `#omos=…` fragment is ATTACKER-CRAFTABLE presentation input — anyone can put one on
 * a link to this app. We read theme, wallpaper and accent from it and nothing else, and
 * nothing read from it is ever used for a decision that matters.
 *
 * A note on who sees this. The admin gets the dashboard's look; a MUSALLI on their own
 * phone does not, and should not — they never opened it from a dashboard, and the masjid's
 * chosen wallpaper is not the right thing to hand a stranger's lock screen. The musalli
 * page defaults to following their phone's own light/dark setting, which is what "dark
 * room at Fajr" actually means in practice.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  wallpaper: string;
  /** Optional custom wallpaper image URL — overrides the preset when set. */
  wallpaperImage: string;
  /** Accent colour id — matches the dashboard's accent when opened from it. */
  accent: string;
  /** Mirror OpenMasjidOS's appearance live (only ever true after an `#omos=` hand-off). */
  followOmos: boolean;
}

const KEY = 'omc-prefs';
const DEFAULTS: Prefs = { theme: 'system', wallpaper: 'aurora', wallpaperImage: '', accent: 'cyan', followOmos: false };

/** Accent palette — mirrors OpenMasjidOS so the app matches the dashboard's accent.
 *  cyan is the tokens' built-in primary, so selecting it just clears the overrides. */
export const ACCENTS: Record<string, { primary: string; hover: string; subtle: string }> = {
  cyan: { primary: '#22D3EE', hover: '#67E8F9', subtle: 'rgba(34,211,238,0.12)' },
  teal: { primary: '#2DD4BF', hover: '#5EEAD4', subtle: 'rgba(45,212,191,0.12)' },
  sky: { primary: '#38BDF8', hover: '#7DD3FC', subtle: 'rgba(56,189,248,0.12)' },
  violet: { primary: '#A78BFA', hover: '#C4B5FD', subtle: 'rgba(167,139,250,0.14)' },
  gold: { primary: '#FBBF24', hover: '#FCD34D', subtle: 'rgba(251,191,36,0.14)' },
};

export function applyAccent(id: string): void {
  const el = document.documentElement;
  const a = ACCENTS[id];
  if (!a || id === 'cyan') {
    for (const p of ['--color-primary', '--color-primary-hover', '--color-primary-subtle', '--color-btn', '--color-btn-hover']) {
      el.style.removeProperty(p);
    }
    return;
  }
  el.style.setProperty('--color-primary', a.primary);
  el.style.setProperty('--color-primary-hover', a.hover);
  el.style.setProperty('--color-primary-subtle', a.subtle);
  el.style.setProperty('--color-btn', a.primary);
  el.style.setProperty('--color-btn-hover', a.hover);
}

/** The nine wallpapers OpenMasjidOS offers, so an inherited choice resolves to the same
 *  scene here. The ids are the contract; the labels are for the admin's own picker. */
export const WALLPAPERS: Record<string, { label: string }> = {
  aurora: { label: 'Aurora' },
  ocean: { label: 'Ocean' },
  twilight: { label: 'Twilight' },
  berry: { label: 'Berry' },
  sunset: { label: 'Sunset' },
  ember: { label: 'Ember' },
  forest: { label: 'Forest' },
  night: { label: 'Night' },
  graphite: { label: 'Graphite' },
};

export function resolveTheme(theme: Prefs['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Prefs['theme']): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(theme));
}

export function applyWallpaper(id: string): void {
  document.documentElement.setAttribute('data-wallpaper', WALLPAPERS[id] ? id : 'aurora');
}

const THEME_VALUES = ['system', 'dark', 'light'] as const;
function normTheme(v: unknown): Prefs['theme'] {
  return (THEME_VALUES as readonly string[]).includes(String(v)) ? (v as Prefs['theme']) : 'system';
}

/** Appearance handed over by OpenMasjidOS. Presentation only — never identity. */
export interface OmosAppearance {
  theme?: string;
  wallpaper?: string;
  wallpaperImage?: string;
  accent?: string;
  lang?: string;
}

export function appearancePatch(p: OmosAppearance): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (p.theme != null) out.theme = normTheme(p.theme);
  if (typeof p.wallpaper === 'string') out.wallpaper = p.wallpaper;
  if (typeof p.accent === 'string') out.accent = p.accent;
  // wallpaperImage comes from the attacker-craftable fragment. Stored as-is; the scene
  // SANITISES it before it reaches a CSS url(...) — see safeImageUrl below.
  if (typeof p.wallpaperImage === 'string') out.wallpaperImage = p.wallpaperImage;
  return out;
}

/**
 * A background-image URL that is safe to interpolate into `url(...)`.
 *
 * Two separate problems, both real: the value arrives from a URL fragment anybody can
 * craft, and it lands inside a CSS function where a quote or a backslash escapes the
 * context. So: http(s) or a data:image only, and no character that could terminate the
 * url() token. Anything else becomes '' and the preset scene is used instead.
 */
export function safeImageUrl(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (/["'\\()\s]/.test(v)) return '';
  if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return '';
}

/** Read the `#omos=…` appearance fragment OpenMasjidOS adds when it opens us (base64url
 *  JSON). Applied once, then the hash is cleared so a refresh or a shared link does not
 *  carry it around. */
function readOmosFragment(): OmosAppearance | null {
  const m = location.hash.match(/omos=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes)) as OmosAppearance;
    history.replaceState(null, '', location.pathname + location.search);
    return p;
  } catch {
    return null;
  }
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

let state: Prefs = load();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private browsing — it just will not persist */
  }
}

export const prefsStore = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(part: Partial<Prefs>) {
    state = { ...state, ...part };
    persist();
    if (part.theme !== undefined) applyTheme(state.theme);
    if (part.wallpaper !== undefined) applyWallpaper(state.wallpaper);
    if (part.accent !== undefined) applyAccent(state.accent);
    for (const l of listeners) l();
  },
  /** Apply persisted prefs on first load, adopt any OpenMasjidOS hand-off, and follow the
   *  phone's own light/dark setting live. */
  hydrate() {
    const omos = readOmosFragment();
    if (omos) {
      // Opened from the dashboard → adopt its look and start following it.
      state = { ...state, ...appearancePatch(omos), followOmos: true };
      persist();
    }
    applyTheme(state.theme);
    applyWallpaper(state.wallpaper);
    applyAccent(state.accent);
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme('system');
    });
  },
};

export function usePrefs(): Prefs {
  return useSyncExternalStore(prefsStore.subscribe, prefsStore.get, prefsStore.get);
}

/** `prefers-reduced-motion`, live. Every animated thing in this app asks before moving —
 *  a countdown that ticks is the one piece of motion a musalli cannot opt out of by not
 *  scrolling, so it has to respect this. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Follow OpenMasjidOS's appearance live, through our own server's relay.
 *
 * The relay is not an indirection for its own sake (CLAUDE.md §6.2): our page is HTTPS behind
 * the tunnel and the platform is plain HTTP on the LAN, so a direct fetch from here is mixed
 * content and the browser blocks it.
 *
 * Only ever active after an `#omos=` hand-off, which in practice means the admin who opened
 * this from their dashboard. A musalli never opened a dashboard and should not inherit the
 * masjid's wallpaper onto their own phone.
 */
export function useAppearanceSync(): void {
  const { followOmos } = usePrefs();
  useEffect(() => {
    if (!followOmos) return;
    let alive = true;
    const pull = async () => {
      const r = await api.get<OmosAppearance>('/api/public/appearance');
      if (!alive || !r.ok) return; // the core being down is not an error worth showing anyone
      const patch = appearancePatch(r.data);
      // Only write when something actually moved. Without this the store notifies every
      // subscriber twice a minute for ever, re-rendering a panel that has not changed.
      const now = prefsStore.get();
      const changed = (Object.keys(patch) as (keyof Prefs)[]).some((k) => patch[k] !== now[k]);
      if (changed) prefsStore.patch(patch);
    };
    void pull();
    const id = setInterval(pull, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [followOmos]);
}

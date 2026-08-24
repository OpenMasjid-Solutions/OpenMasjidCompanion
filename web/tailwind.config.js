// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/** Tailwind is additive utilities ONLY. Preflight is off so the hand-written token CSS
 *  (styles/app.css, mirrored from OpenMasjidOS and OpenMasjid Display) stays authoritative
 *  for base styles. Colours map to the CSS custom properties in styles/tokens.css, so a
 *  utility like `bg-surface` or `text-ink` follows the theme, the wallpaper and the
 *  dashboard's accent. Never put a raw hex in a component — add a token, then map it here. */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        surface: 'var(--color-surface)',
        'surface-raised': 'var(--color-surface-raised)',
        'surface-overlay': 'var(--color-surface-overlay)',
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
        accent: 'var(--color-accent)',
        gold: 'var(--color-gold)',
        ink: 'var(--color-ink)',
        'ink-muted': 'var(--color-ink-muted)',
        'ink-faint': 'var(--color-ink-faint)',
        border: 'var(--color-border)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        danger: 'var(--color-danger)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        button: 'var(--radius-button)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        display: 'var(--font-display)',
      },
    },
  },
  plugins: [],
};

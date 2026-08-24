// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string;

// The musalli app and the admin panel are one bundle, served by the Node server, which
// also exposes /api. In dev (`npm run dev`) we proxy the server routes to :8080 so the
// same fetches work locally and in production.
export default defineConfig({
  plugins: [react()],
  // RELATIVE asset base. The built index.html references assets as ./assets/…, which
  // resolve against the runtime `<base href>` the server injects — so ONE build works at
  // the root (a kiosk on the LAN) AND under any admin-chosen tunnel path, without the
  // path being baked in at build time. Dynamic import() chunks resolve via
  // import.meta.url, so the lazily-loaded admin panel follows the prefix too.
  //
  // Do NOT change this to an absolute base: it works perfectly on the LAN and gives every
  // phone that scanned the QR code a blank page.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A musalli opens this on a phone, often on masjid wifi, sometimes at Fajr on mobile
    // data. Warn early if the first-load bundle starts creeping — the admin panel is
    // lazy-loaded precisely so it never lands in it.
    chunkSizeWarningLimit: 260,
  },
});

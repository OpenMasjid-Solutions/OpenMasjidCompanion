// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/* Autoprefixer only. Tailwind was removed in 0.3.0-dev.5 — one used utility was not worth a
   build dependency, and that dependency's own tree carried five high-severity advisories whose
   only remedy was a major-version migration. */
export default {
  plugins: {
    autoprefixer: {},
  },
};

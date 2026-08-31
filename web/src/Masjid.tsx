// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * A masjid, as a line icon.
 *
 * Drawn here because lucide does not have one — it carries `Church`, `Landmark` and `Castle`, and
 * heading a masjid's own details with a church is worse than heading them with nothing. It is
 * our own drawing of a generic building form (dome, crescent, two minarets), which is not
 * anybody's mark and is therefore an asset this repository can license under AGPL like the rest.
 *
 * Shaped to sit in a row of lucide icons without looking like a visitor: a 24-unit box, stroked
 * in `currentColor` at 1.8 with round joins, and no fill. It is deliberately SIMPLER than the
 * reference Hasan sent — the windows and the doorway's inner arch disappear into two grey pixels
 * at the 16px this is actually used at, and detail that resolves to noise makes an icon read
 * worse, not better.
 */
export function MasjidIcon({ size = 16, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The crescent, open to the right, as on a finial. A stroked arc rather than two
          overlapping circles, which is how a crescent is usually faked and which needs a fill
          to work — this has none. */}
      <path d="M13.1 2.6a1.75 1.75 0 1 0 1.1 2.6" />
      {/* The finial's shaft, down to the dome. */}
      <path d="M12 6.6V5.3" />
      {/* The dome: two mirrored curves meeting at the top, which is the onion shape. */}
      <path d="M8.3 13.4c0-2.6 3.7-3.7 3.7-6.8 0 3.1 3.7 4.2 3.7 6.8" />
      {/* The hall. */}
      <path d="M7.4 21v-7.6h9.2V21" />
      {/* The doorway, arched. */}
      <path d="M10.3 21v-2.7a1.7 1.7 0 0 1 3.4 0V21" />
      {/* The minarets: a shaft with a spire, one each side. */}
      <path d="M3.4 21V10.1l1.3-3.4 1.3 3.4V21" />
      <path d="M18 21V10.1l1.3-3.4 1.3 3.4V21" />
      {/* The ground, tying the three together. */}
      <path d="M2.3 21h19.4" />
    </svg>
  );
}

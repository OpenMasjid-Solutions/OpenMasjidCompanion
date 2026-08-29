// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The bottom tab bar — Salah, Donate, and Qibla when it arrives.
 *
 * A phone-shaped app gets phone-shaped navigation: the thumb rests at the bottom of the screen,
 * not the top, and a musalli checking Maghrib on the way out of the door should not have to
 * scroll to find anything.
 *
 * **The bar only appears when there is more than one place to go.** A masjid with no appeals
 * running — which is most masjids most of the year — gets no bar at all rather than a single
 * lit tab labelled "Salah" over the only page there is. One tab is not navigation, it is a
 * label taking up the most valuable strip of a phone screen.
 *
 * They are real `<a href>`s, not buttons: a middle-click or a long-press should offer to open
 * in a new tab like any other link, and the href is what makes that work. The click handler
 * only takes over the plain left-click.
 */
import type { LucideIcon } from 'lucide-react';
import { withBase } from './base';

export interface Tab {
  route: string;
  label: string;
  icon: LucideIcon;
}

export function TabBar({
  tabs,
  route,
  onGo,
}: {
  tabs: Tab[];
  route: string;
  onGo: (to: string) => (e: React.MouseEvent) => void;
}): JSX.Element | null {
  if (tabs.length < 2) return null;

  return (
    <nav className="tabbar no-print" aria-label="Sections">
      {tabs.map((t) => {
        const on = t.route === route;
        const Icon = t.icon;
        return (
          <a
            key={t.route}
            className={on ? 'tab tab--on' : 'tab'}
            href={withBase(t.route)}
            onClick={onGo(t.route)}
            // `aria-current` rather than aria-selected: these are links to pages, not tabs in
            // a tabpanel widget, and a screen reader should say "current page".
            aria-current={on ? 'page' : undefined}
          >
            <Icon size={21} aria-hidden="true" strokeWidth={on ? 2.4 : 1.9} />
            <span className="tab__label">{t.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

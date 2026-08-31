// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * site.ts — what this app currently believes about its own address on the internet.
 *
 * Three things depend on getting this right, and each fails differently when it is wrong:
 *
 *  - **The base path.** Behind the tunnel every request arrives with the admin's prefix still
 *    on the front ("/companion/api/app"). `rewriteUrl` strips it before routing — but only if
 *    we know what it is. Wrong, and every route 404s for everyone outside the building while
 *    working perfectly on the LAN, which is the hardest kind of bug to be told about.
 *  - **The public URL.** It goes on a printed QR code. A wrong one is a poster on a
 *    noticeboard that quietly works for nobody, and posters do not get reprinted.
 *  - **Whether remote access is on at all.** Install prompts and push notifications cannot
 *    work over plain HTTP, so offering them on a LAN address is offering a button that cannot
 *    do anything.
 *
 * None of it is persisted. The platform rewrites all of it across a restore onto a new
 * machine, and a cached copy would point at the old box — see config.ts.
 */
import { config, ssoConfigured } from './config';
import { getBasePath, normBasePath, setBasePath } from './basePath';
import { type FabricSite, fetchSite } from './fabric';
import { makeLog } from './logger';

const log = makeLog('site');

export interface SiteState extends FabricSite {
  /** Is the Fabric configured at all? False on a standalone install, where none of this
   *  applies and the admin should not be told to go and fix something that is fine. */
  configured: boolean;
  /** ms epoch of the last SUCCESSFUL lookup; 0 = we have never heard from the platform. */
  checkedAt: number;
  /** Did the most recent ATTEMPT succeed? Separate from `checkedAt` so the admin panel can
   *  distinguish "never asked" from "asked, and it is down right now". */
  ok: boolean;
}

/**
 * The base path we can work out before the Fabric has answered anything.
 *
 * `OPENMASJID_PUBLIC_URL` is injected at container start and already contains the prefix
 * ("https://omos.example.org/companion"), so its pathname IS the base path. Using it closes a
 * real gap: without it there is a window from process start until the first successful site
 * lookup — seconds normally, unbounded if the platform is slow to come up after a reboot — in
 * which every tunnelled request 404s because nothing is being stripped. A masjid rebooting
 * their box should not have to wait out that window.
 */
export function basePathFromPublicUrl(publicUrl: string): string {
  if (!publicUrl) return '';
  try {
    return normBasePath(new URL(publicUrl).pathname);
  } catch {
    return '';
  }
}

let state: SiteState = {
  enabled: false,
  domain: '',
  publicUrl: config.omosPublicUrl,
  basePath: basePathFromPublicUrl(config.omosPublicUrl),
  configured: ssoConfigured(),
  checkedAt: 0,
  ok: false,
};

// Apply the boot-time guess immediately, so the very first request through the tunnel routes.
setBasePath(state.basePath);

export function getSite(): SiteState {
  return state;
}

/**
 * Ask the platform, and adopt the answer.
 *
 * THE RULE THAT MATTERS: a failed lookup changes nothing. We keep the last known good base
 * path, public URL and enabled flag.
 *
 * It is tempting to treat "cannot reach the platform" as "no remote access", and it would be
 * exactly backwards. The tunnel is Cloudflare's and the container is ours; both keep running
 * perfectly well while the OpenMasjidOS core is restarting. Clearing the base path because the
 * core blinked would take the app off the internet for the duration — turning a platform
 * hiccup into an outage of the one thing musallis actually use.
 *
 * The fetcher is injectable so a test can drive every branch without a network.
 */
export async function refreshSite(fetcher: () => Promise<FabricSite | null> = fetchSite): Promise<SiteState> {
  if (!ssoConfigured()) {
    state = { ...state, configured: false, ok: false };
    return state;
  }
  const site = await fetcher();
  if (!site) {
    state = { ...state, configured: true, ok: false };
    return state;
  }

  const previous = state;
  state = { ...site, configured: true, checkedAt: Date.now(), ok: true };

  // The base path is the one field with an effect outside this module.
  if (state.basePath !== getBasePath()) {
    log.info(`base path is now "${state.basePath || '/'}" (was "${getBasePath() || '/'}")`);
    setBasePath(state.basePath);
  }
  if (state.enabled !== previous.enabled || state.publicUrl !== previous.publicUrl) {
    log.info(state.enabled ? `shared over the internet at ${state.publicUrl}` : 'not shared over the internet');
  }
  return state;
}

/** Often enough that turning Remote access on in the dashboard is reflected without the admin
 *  wondering whether it worked; rarely enough to be nothing on a Pi. The admin panel can also
 *  ask for an immediate refresh, which is what a volunteer standing there will actually do. */
const POLL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;

/** Begin following the platform's answer. Safe to call when standalone — it does nothing. */
export function startSitePolling(): void {
  if (timer || !ssoConfigured()) return;
  void refreshSite();
  timer = setInterval(() => void refreshSite(), POLL_MS);
  // Never hold the process open for a poll: a container that will not exit on SIGTERM gets
  // SIGKILLed, and SQLite would rather be closed properly.
  timer.unref?.();
}

export function stopSitePolling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Tests only, so one case cannot leak into the next. */
export function resetSiteForTests(next?: Partial<SiteState>): void {
  stopSitePolling();
  state = {
    enabled: false,
    domain: '',
    publicUrl: '',
    basePath: '',
    configured: ssoConfigured(),
    checkedAt: 0,
    ok: false,
    ...next,
  };
  setBasePath(state.basePath);
}

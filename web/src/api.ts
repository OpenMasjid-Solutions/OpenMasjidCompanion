// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The one place this app talks to its own server.
 *
 * Every call goes through `withBase`, because a root-absolute fetch is exactly the thing
 * `<base href>` does NOT fix: behind the tunnel, `fetch('/api/app')` would leave this app
 * entirely and hit whatever the platform serves at the root.
 *
 * Every response is `{ data }` on success or `{ error }` on failure, and this returns a
 * discriminated result rather than throwing. A musalli standing outside the masjid with
 * one bar of signal is the normal case, not the exceptional one, so "it did not work" is
 * a value the UI renders, not an exception it has to catch.
 */
import { withBase } from './base';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const GENERIC = 'Something went wrong. Please try again.';

async function request<T>(pathname: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(withBase(pathname), {
      ...init,
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
      // Our own origin, our own cookie. Never sent anywhere else.
      credentials: 'same-origin',
    });
    const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
    if (!res.ok) return { ok: false, error: typeof body?.error === 'string' ? body.error : GENERIC };
    if (!body || body.data === undefined) return { ok: false, error: GENERIC };
    return { ok: true, data: body.data };
  } catch {
    // Offline, or the box is off. Both are ordinary here.
    return { ok: false, error: 'No connection to the masjid right now.' };
  }
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
};

/** The public bootstrap every page reads on load. No secrets — this is fetched by every
 *  phone that opens the app. */
export interface AppInfo {
  name: string;
  version: string;
  /** Running under OpenMasjidOS with the Fabric available. Not "signed in". */
  embedded: boolean;
  /** This app's public address, or '' when the admin has not shared it over the tunnel.
   *  Everything musalli-facing that needs HTTPS keys off this being non-empty. */
  publicUrl: string;
  basePath: string;
}

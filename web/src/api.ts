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
  /** Raw bytes, for the icon upload. Sent with its real content type rather than base64 inside
   *  JSON, which would inflate a few hundred KB by a third for nothing. The server validates
   *  from the magic numbers regardless, so the type declared here is a courtesy, not a claim it
   *  acts on. */
  postBinary: <T>(p: string, body: Blob, contentType: string) =>
    request<T>(p, { method: 'POST', body, headers: { 'content-type': contentType } }),
};

/** The public bootstrap every page reads on load. No secrets — this is fetched by every
 *  phone that opens the app. */
export interface AppInfo {
  name: string;
  version: string;
  /** Running under OpenMasjidOS with the Fabric available. Not "signed in". */
  embedded: boolean;
  /** This app's public address, or '' when the admin has not shared it over the tunnel.
   *  Live from the platform, not the boot-time environment — the admin can turn sharing on
   *  without restarting anything. */
  publicUrl: string;
  /** The prefix the router is actually stripping. Every URL this page builds goes through it. */
  basePath: string;
  /** What this app is called on a home screen — the masjid's name, not ours. The install
   *  prompt uses it, so a musalli is told they are adding their masjid. */
  installName: string;
  /** Whether install and notifications can HONESTLY be offered. Both need a secure context,
   *  which means the tunnel; over plain http on the LAN neither API exists at all. */
  remote: { configured: boolean; enabled: boolean; secure: boolean };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Boundary.tsx — the last honest state.
 *
 * WHY THIS EXISTS. This app already has a designed answer for every upstream failure it can
 * name: Display unreachable, an appeal that 404s, remote access off, a timetable too stale to
 * notify from. It had no answer for the one failure it cannot name — a component that throws
 * while rendering. React's response to that is to unmount the entire tree, so the musalli gets
 * a white screen: no times, no explanation, and on an installed PWA no address bar to reload
 * from. That is the second-worst thing this app can do to somebody, after showing them a wrong
 * prayer time, and it was the only failure mode with no screen behind it.
 *
 * IT IS NOT STYLED AS AN ERROR, for the reason `Note` in ui.tsx is not: a red panel on a
 * prayer-times page tells a reader the masjid is broken. What is true is narrower — this app
 * could not draw a page — and the useful next step is simply to try again.
 *
 * WHAT IT DOES NOT DO. It does not report anywhere. There is no error-reporting endpoint in
 * this app and adding one would quietly turn a page with no visitor log into a page with a
 * visitor log (CLAUDE.md §4). The details go to the browser console, where a developer or a
 * volunteer on a phone-support call can read them, and nowhere else.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The one line shown to the reader.
 *
 * Deliberately the same sentence whatever threw. A musalli cannot act on "Cannot read
 * properties of undefined", and the difference between one thrown value and another is a
 * developer's question, answered in the console. Exported because it is the only part of this
 * file a test without a DOM can reach.
 */
export function crashMessage(): string {
  return 'This page could not be drawn.';
}

/**
 * The technical line, for the console and the details expander.
 *
 * Anything can be thrown in JavaScript, including a string, `undefined`, or an object with a
 * `message` that is not a string — so this never assumes it was handed an `Error`.
 */
export function crashDetail(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

interface State {
  error: unknown;
  failed: boolean;
}

export class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the whole of the reporting. See the file comment.
    console.error('[companion] a component threw while rendering', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="shell">
        <section className="set-card" role="alert">
          <h1 className="set-title">{crashMessage()}</h1>
          <p className="set-lead">
            Your masjid&rsquo;s prayer times are fine &mdash; this is a fault in the app itself. Reloading usually fixes
            it.
          </p>
          <button className="btn btn--primary" onClick={() => location.reload()}>
            Reload
          </button>
          <details className="crash-details">
            <summary>Technical details</summary>
            <pre>{crashDetail(this.state.error)}</pre>
          </details>
        </section>
      </main>
    );
  }
}

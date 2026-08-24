// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Tiny tagged logger. Keep it boring — and never log a secret.
 *
 * In this app that list is specific and worth naming, because two of the three are not
 * the kind of thing a reviewer expects to find in a log line:
 *
 *  - `OPENMASJID_APP_SECRET` — the platform's per-app credential.
 *  - The VAPID **private** key — this app's long-lived identity toward every push
 *    service. It lives on the data volume and must never reach a log or a browser.
 *  - A push **endpoint** in full. It is a pseudo-identifier for one musalli's phone,
 *    and the whole privacy posture of the notification feature is that we hold nothing
 *    that identifies anybody. A log line is a copy of it we cannot delete later.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

function emit(level: Level, tag: string, args: unknown[]): void {
  if (order[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${tag}]`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line, ...args);
}

export function makeLog(tag: string) {
  return {
    debug: (...a: unknown[]) => emit('debug', tag, a),
    info: (...a: unknown[]) => emit('info', tag, a),
    warn: (...a: unknown[]) => emit('warn', tag, a),
    error: (...a: unknown[]) => emit('error', tag, a),
  };
}

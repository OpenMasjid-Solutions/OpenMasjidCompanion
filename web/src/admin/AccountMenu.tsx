// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The account menu — who is signed in, which version this is, what changed, where the source
 * is, and the way out.
 *
 * "What's new" is not a nicety. OpenMasjidOS updates apps in the background, so an admin's
 * Companion app can change overnight with nothing on screen to say what changed. The notes
 * ship inside the image, so this works on a box with no internet.
 *
 * The "Source code" link is an AGPL obligation, not decoration (§13 of the licence, and
 * CLAUDE.md §2): this app is used over a network by people who never installed it, so the
 * offer of source has to be reachable from the interface.
 */
import { useEffect, useRef, useState } from 'react';
import { Github, LogOut, Sparkles, UserRound, X } from 'lucide-react';
import { api } from '../api';

const REPO = 'https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion';

interface ReleaseItem {
  text: string;
  /** A `### Added` / `### Fixed` group label rather than a change. The SERVER decides this —
   *  see changelog.ts — so the panel never has to guess from the text. */
  heading?: true;
}

interface Release {
  version: string;
  items: ReleaseItem[];
}

/** Render the small amount of inline markdown our own changelog actually uses. Deliberately
 *  not a markdown renderer: the input is a file we write, and anything that turned arbitrary
 *  text into HTML here would be a needless injection surface in an admin panel. */
function Inline({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** Split a flat item list into `{ heading, items }` groups at each marked heading. Items
 *  before the first heading form an unlabelled group, so a release written without any
 *  `###` sections renders exactly as it did. */
function groupItems(items: ReleaseItem[]): { heading?: string; items: ReleaseItem[] }[] {
  const groups: { heading?: string; items: ReleaseItem[] }[] = [];
  for (const item of items) {
    if (item.heading) groups.push({ heading: item.text, items: [] });
    else {
      if (groups.length === 0) groups.push({ items: [] });
      groups[groups.length - 1].items.push(item);
    }
  }
  return groups.filter((g) => g.items.length > 0 || g.heading);
}

function WhatsNew({ onClose }: { onClose: () => void }): JSX.Element {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ version: string; releases: Release[] }>('/api/changelog').then((r) => {
      if (r.ok) setReleases(r.data.releases);
      else setError(r.error);
    });
  }, []);

  // Escape closes, and focus starts inside — a dialog a keyboard cannot leave is a trap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div className="glass-raised modal" role="dialog" aria-modal="true" aria-label="What's new" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="section-title">What&rsquo;s new</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="modal-body">
          {error && <p className="muted">{error}</p>}
          {!releases && !error && <span className="spinner" />}
          {releases?.length === 0 && <p className="muted">No release notes shipped with this build.</p>}
          {releases?.map((r) => (
            <section key={r.version} className="release">
              <h3 className="release-version">{r.version}</h3>
              {/* Group labels break the list rather than joining it, so "Added" reads as a
                  heading over the changes under it instead of as a change itself. */}
              {groupItems(r.items).map((group, gi) => (
                <div key={gi}>
                  {group.heading && <h4 className="release-group">{group.heading}</h4>}
                  <ul className="release-items">
                    {group.items.map((item, i) => (
                      <li key={i}>
                        <Inline text={item.text} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function AccountMenu({ username, version, onSignedOut }: { username?: string; version: string; onSignedOut: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [whatsNew, setWhatsNew] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    await api.post('/api/logout');
    setOpen(false);
    onSignedOut();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button className="icon-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="Account">
        <UserRound size={19} aria-hidden="true" />
      </button>
      {open && (
        <div className="glass-raised menu" role="menu">
          <div className="menu-head">
            <div className="menu-name">{username || 'Signed in'}</div>
            <div className="menu-sub tnum">Version {version}</div>
          </div>
          <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); setWhatsNew(true); }}>
            <Sparkles size={16} aria-hidden="true" /> What&rsquo;s new
          </button>
          <a className="menu-item" role="menuitem" href={REPO} target="_blank" rel="noopener noreferrer">
            <Github size={16} aria-hidden="true" /> Source code
          </a>
          <button className="menu-item menu-item--danger" role="menuitem" onClick={signOut}>
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
      {whatsNew && <WhatsNew onClose={() => setWhatsNew(false)} />}
    </div>
  );
}

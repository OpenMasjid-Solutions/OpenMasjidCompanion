// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { createRoot } from 'react-dom/client';
import { App } from './App';
import { prefsStore } from './prefs';
import './styles/index.css';

// Apply the persisted look and any OpenMasjidOS hand-off BEFORE the first render, so the
// app never flashes the wrong theme at somebody in a dark prayer hall.
prefsStore.hydrate();

createRoot(document.getElementById('root')!).render(<App />);

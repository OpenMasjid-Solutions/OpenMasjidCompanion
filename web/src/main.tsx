// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import { createRoot } from 'react-dom/client';
import { App, dashboardLanding, routeOf } from './App';
import { Boundary } from './Boundary';
import { OPENED_FROM_DASHBOARD, prefsStore } from './prefs';
import { withBase } from './base';
import './styles/index.css';

// An admin who pressed "Open" in their dashboard wants the settings, not the musalli page.
// Decided BEFORE the first render so they never see the wrong screen flash past, and with
// `replaceState` rather than a push so Back does not bounce them straight into it again.
// `routeOf` is what strips the tunnel prefix, so the decision below is made about the ROUTE
// rather than a raw pathname that still carries "/companion".
const landing = dashboardLanding(routeOf(location.pathname), OPENED_FROM_DASHBOARD);
if (landing) history.replaceState(null, '', withBase(landing) + location.hash);

// Apply the persisted look and any OpenMasjidOS hand-off BEFORE the first render, so the
// app never flashes the wrong theme at somebody in a dark prayer hall.
prefsStore.hydrate();

createRoot(document.getElementById('root')!).render(
  // A component that throws unmounts the whole tree and leaves a white screen — on an installed
  // PWA, without even an address bar to reload from. See Boundary.tsx.
  <Boundary>
    <App />
  </Boundary>,
);

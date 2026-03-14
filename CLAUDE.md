# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ferramenta** is a Windows desktop app (Electron) for financial operations management — revenue tracking, structured products, options strategies, and market data. The UI is React/Vite; the backend is an embedded Express server.

## Three-Component Architecture

```
electron/        — Electron main process (main.js + preload.js)
pwr/             — React/Vite frontend (pwr/src/)
server/          — Embedded Express API (server/index.js → server/runtimeApp.js)
api/lib/         — Shared parser/service libs used by server and packaged in the Electron asar
```

At runtime in the packaged app, Electron launches the window and simultaneously starts the Express server embedded in-process (port 4170, fallback 4171). The React app communicates with this server via `fetch('/api/...')`. In dev, Vite proxies `/api` to `localhost:4170`.

## Dev Commands

All commands are run from the repo root unless noted.

```bash
# Start all three in separate terminals:
npm run dev:api        # Express server on :4170
npm run dev:ui         # Vite dev server on :5173 (from pwr/)
npm run dev:electron   # Electron pointing at VITE_DEV_SERVER_URL=http://localhost:5173

# UI only (inside pwr/):
cd pwr && npm run dev

# Build
npm run build:ui       # Vite build → pwr/dist/
npm run build:electron # build:ui + electron-builder (Win x64 NSIS installer → dist_electron/)

# Tests (run from repo root or pwr/)
cd pwr && npm test     # runs pwr/scripts/tests.js via Node (uses assert, no framework)

# Lint (inside pwr/)
cd pwr && npm run lint

# Release
npm run release:win    # PowerShell script: bumps version, builds, uploads to S3
```

## IPC Bridge (Electron ↔ React)

`electron/preload.js` exposes `window.electronAPI` and `window.pwr` via `contextBridge`. The React code must never assume Electron is present — all callers check `isDesktop()` from `pwr/src/services/nativeStorage.js`:

```js
export const isDesktop = () => typeof window !== 'undefined' && Boolean(window.electronAPI)
```

Key IPC namespaces: `electronAPI.storage` (JSON file store, whitelist-guarded in main.js), `electronAPI.config` (config.json), `electronAPI.updates` (electron-updater → AWS S3), `electronAPI.runtime` (embedded server state), `electronAPI.ocr` (Windows OCR via PowerShell).

## Frontend Architecture (pwr/src/)

**Routing**: Hash-based via `useHashRoute` hook. Routes registered in `routeRegistry.js` — all pages lazy-loaded with custom `createLazyRoute` that deduplicates the import promise and exposes `.preload()`. After login, all routes are preloaded in background using `requestIdleCallback`.

**Auth**: Firebase (`pwr/src/firebase.js`). `App.jsx` listens to `onAuthStateChanged` and gates rendering behind `<AccessGate>`. User key stored on `window.__PWR_USER_KEY__` and `localStorage.pwr.userKey`.

**Global State**:
- `GlobalFilterContext` — broker/assessor/client/apuracao filters, persisted to localStorage and broadcast across tabs via `BroadcastChannel` (fallback: `storage` events).
- `HubxpContext` — manages HubXP session lifecycle (Playwright-based scraping in the embedded server).
- `OutlookContext` — similar pattern for Outlook mail scraping.

**Page Caching**: `<KeepAlive>` keeps up to 6 pages mounted but hidden (`display:none`) to avoid remounting on navigation.

**Cross-component events** (custom DOM events):
- `pwr:receita-updated` — fired when revenue data changes; triggers apuracao options refresh in GlobalFilterContext.
- `pwr:tags-updated` — fired when tags/links change; triggers tag index rebuild.

## Data Layer

Revenue data is stored in localStorage under keys `pwr.receita.*` (and mirrored to Electron's file-based storage for the same keys). The whitelist of Electron-persisted keys lives in `electron/main.js` as `STORAGE_KEYS`.

The `api/lib/` directory contains parsers for Excel imports (estruturadas, bovespa, BMF) and service libs (dividends from Yahoo/Brapi, CDI, earnings calendar). These run in both the embedded server and directly in the Electron asar.

The `server/runtimeApp.js` is the actual Express app (lazily loaded by `server/index.js` to avoid slow startup). Add new API routes there or in `server/hubxpOrders.js` / `server/outlookMail.js`.

## Build & Release

- Electron-builder produces a Windows NSIS installer, output to `dist_electron/`.
- Auto-updates use `electron-updater` pointing at an AWS S3 bucket (`ferramenta-updates-937506434821`, region `sa-east-1`).
- The update URL can be overridden via `config.updateBaseUrl` or `UPDATE_BASE_URL` env var. Legacy Vercel Blob URLs are rejected.
- `scripts/release-win.ps1` orchestrates the full release flow.

## Environment Variables

Copy `.env.example` to `.env` at the repo root. Key vars:
- `BRAPI_TOKEN` — required for Brazilian stock quotes
- `PORT` — Express server port (default 4170)
- `DEBUG_RECEITAS=1` — logs parsed receita stats to console
- `HUBXP_*` — HubXP scraping config (Playwright)
- `OUTLOOK_*` — Outlook scraping config (Playwright)
- `AWS_*` / `UPDATE_BASE_URL` — release pipeline

## Key Conventions

- **Language**: UI code is in Brazilian Portuguese (variable names, labels, comments). Keep this consistent.
- **Module systems**: Root and `server/` use CommonJS (`require`). `pwr/` uses ES modules (`import`). `api/lib/` must be compatible with both (CommonJS).
- **No legacy folders**: `pages/`, `app/`, `src/` at the root are legacy and unused. Active source is `pwr/src/`.
- **Vite build target**: `chrome120` (Electron 33 = Chromium 130). Avoid modern APIs not available in Chrome 120.
- **Tests**: `pwr/scripts/tests.js` uses `node:assert` directly — no Jest or Vitest. Run with `node pwr/scripts/tests.js` or `npm test` inside `pwr/`.

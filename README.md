# DALI Scout

DALI bus monitor and gear simulator (Electron + TypeScript). See [docs/SPEC.md](docs/SPEC.md) for the full spec and milestone plan.

## Status: milestone 1 (foundations)
- `packages/core` — frame model, stateful IEC 62386-102 decoder, answer correlation, `.dscap` capture format
- `packages/transports` — transport interface, in-process virtual bus, capture replay
- `apps/desktop` — Electron monitor: open a capture or run the demo, live table, text search, detail panel

No hardware transport yet (USB HID is milestone 2).

## Develop
Requires **Node >= 22.12** (`nvm use` picks it up from `.nvmrc`).
```sh
npm install        # run on the machine that will run the app (native optional deps are per-OS)
npm test           # vitest (core + transports)
npm run typecheck
npm run dev        # Electron app with the demo capture ("Demo" button)
node scripts/make-demo.mjs   # regenerate examples/demo.dscap
```
Run `npm run dev` on the host, not in the devcontainer (no display / USB passthrough there).

### Troubleshooting
- **`Electron uninstall`** — the Electron binary was not downloaded (`npm install` with `ELECTRON_SKIP_BINARY_DOWNLOAD` set or `ignore-scripts=true`). Run `node node_modules/electron/install.js`.
- **`Cannot find native binding` (rolldown)** — wrong Node version or a `node_modules` installed on another OS. Use Node >= 22.12, then `rm -rf node_modules apps/*/node_modules packages/*/node_modules && npm install`.
- **Linux: `The SUID sandbox helper binary was found, but is not configured correctly`** — run
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
  (repeat after reinstalling Electron). For throwaway local dev you can instead start Electron with `--no-sandbox`.
- Stale dev servers (port 5173 busy): `pkill -f electron-vite`.
- Do not share `node_modules` between the devcontainer and the host (native packages are per-OS); reinstall when switching.

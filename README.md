# DALI Scout

DALI bus monitor and gear simulator (Electron + TypeScript). See [docs/SPEC.md](docs/SPEC.md) for the full spec and milestone plan.

## Status: milestone 3 (gear simulator on a virtual bus)
- `packages/core` — frame model, stateful IEC 62386-102 decoder, answer correlation, `.dscap` capture format
- `packages/transports` — transport interface, in-process virtual bus, capture replay
- `packages/transports` also has the USB drivers: **LUBA** (Lunatone DALI-2 USB, serial) and the legacy **DALI USB 24138923** (HID). Both are unit-tested against fake devices; the HID layout is **unverified on real hardware** (see `scripts/hid-probe.mjs`).
- `packages/core/src/sim` — simulated DALI control gears (IEC 62386-102): levels, fading, scenes, groups, send-twice, commissioning, queries, fault injection. Start the **Simulator** tab, then *Start virtual bus*; the Monitor tab shows every telegram, including the gears' answers.
- `apps/desktop` — Electron monitor: device selection, virtual bus, capture replay, live table, structured filters + presets, statistics, send panel, CSV/text/.dscap export

## Develop
Requires **Node >= 22.12** (`nvm use` picks it up from `.nvmrc`).
```sh
npm install        # run on the machine that will run the app (native optional deps are per-OS)
npm test           # vitest (core + transports)
npm run typecheck
npm run dev        # Electron app with the demo capture ("Demo" button)
node scripts/make-demo.mjs   # regenerate examples/demo.dscap
node scripts/hid-probe.mjs   # dump raw HID reports of a DALI USB 24138923
```
### USB devices on Linux
- `sudo apt install libusb-1.0-0` (needed by `node-hid`)
- `sudo cp docs/udev/70-dali-usb.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger`, then replug the interface
Run `npm run dev` on the host, not in the devcontainer (no display / USB passthrough there).

### Troubleshooting
- **`Electron uninstall`** — the Electron binary was not downloaded (`npm install` with `ELECTRON_SKIP_BINARY_DOWNLOAD` set or `ignore-scripts=true`). Run `node node_modules/electron/install.js`.
- **`Cannot find native binding` (rolldown)** — wrong Node version or a `node_modules` installed on another OS. Use Node >= 22.12, then `rm -rf node_modules apps/*/node_modules packages/*/node_modules && npm install`.
- **Linux: `The SUID sandbox helper binary was found, but is not configured correctly`** — run
  `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`
  (repeat after reinstalling Electron). For throwaway local dev you can instead start Electron with `--no-sandbox`.
- Stale dev servers (port 5173 busy): `pkill -f electron-vite`.
- Do not share `node_modules` between the devcontainer and the host (native packages are per-OS); reinstall when switching.

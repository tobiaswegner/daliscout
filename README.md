# DALI Scout

DALI bus monitor and gear simulator (Electron + TypeScript). See [docs/SPEC.md](docs/SPEC.md) for the full spec and milestone plan.

## Status: milestone 1 (foundations)
- `packages/core` — frame model, stateful IEC 62386-102 decoder, answer correlation, `.dscap` capture format
- `packages/transports` — transport interface, in-process virtual bus, capture replay
- `apps/desktop` — Electron monitor: open a capture or run the demo, live table, text search, detail panel

No hardware transport yet (USB HID is milestone 2).

## Develop
```sh
npm install        # run on the machine that will run the app (native optional deps are per-OS)
npm test           # vitest (core + transports)
npm run typecheck
npm run dev        # Electron app with the demo capture ("Demo" button)
node scripts/make-demo.mjs   # regenerate examples/demo.dscap
```
Run `npm run dev` on the host, not in the devcontainer (no display / USB passthrough there).

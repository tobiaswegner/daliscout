#!/usr/bin/env node
// Experiment: can the legacy Tridonic/Lunatone "DALI USB" (17b5:0020) transmit a DALI *backward*
// frame (an 8-bit answer)? DALI Scout needs that to simulate gears on a live bus.
//
// The python-dali driver defines a command code 0x15 ("SEND_ANSWER") that it never uses. Its
// report layout is unknown, so this script tries a few plausible layouts one after the other and
// prints every report the device sends back, so we can see which (if any) it accepts.
//
//   node scripts/hid-answer-probe.mjs                  # try answer byte 0xFE with modes 0,1,2
//   node scripts/hid-answer-probe.mjs --byte 5A        # other answer byte
//   node scripts/hid-answer-probe.mjs --modes 1,2,4    # other mode values to try
//   node scripts/hid-answer-probe.mjs --no-baseline    # skip the harmless FF 90 reference send
//
// Only command codes 0x01 (info), 0x12 (known send) and 0x15 (the experiment) are ever sent.
// Needs a powered DALI bus (check the STATUS report at the start: "OK" means the bus is alive).
// What to look for: a report with kind RESPONSE or OBSERVED and type DALI8 carrying your byte,
// or any report that differs from the NO_FRAME acknowledgements. Save the output and send it over.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);
const byte = parseInt(opt('--byte', 'FE'), 16);
const modes = opt('--modes', '0,1,2').split(',').map((x) => Number(x));
if (!(byte >= 0 && byte <= 255) || modes.some((m) => !(m >= 0 && m <= 255))) {
  console.error('--byte must be a hex byte, --modes a comma list of numbers 0..255');
  process.exit(4);
}

let HID;
try { HID = require('node-hid'); } catch (e) {
  console.error('Cannot load node-hid:', e.message.split('\n')[0]);
  process.exit(1);
}
const VID = 0x17b5, PID = 0x0020;
let dev;
try { dev = HID.devices().find((d) => d.vendorId === VID && d.productId === PID); } catch (e) {
  console.error('Cannot use node-hid:', e.message.split('\n')[0]);
  console.error('Linux: install libusb-1.0 (apt install libusb-1.0-0).');
  process.exit(1);
}
if (!dev) { console.error('No DALI USB (17b5:0020) found.'); process.exit(2); }

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const KIND = { 0x01: 'INFO', 0x11: 'OBSERVED', 0x12: 'RESPONSE' };
const TYPE = { 0x71: 'NO_FRAME', 0x72: 'DALI8', 0x73: 'DALI16', 0x74: 'EDALI25', 0x76: 'DALI24', 0x77: 'STATUS' };
const STATUS = { 1: 'CHECKSUM', 2: 'SHORTED', 3: 'FRAMING_ERROR', 4: 'OK', 5: 'DSI_MODE', 6: 'DALI_MODE' };
const t0 = Date.now();
let current = 'init';

const h = new HID.HID(dev.path);
h.on('error', (e) => { console.error('HID error:', e.message); process.exit(3); });
h.on('data', (buf) => {
  const b = Uint8Array.from(buf);
  const st = b[1] === 0x77 ? `  => bus status ${STATUS[b[5]] ?? b[5]}` : '';
  console.log(`  +${String(Date.now() - t0).padStart(6)} ms [${current}] ${hex(b.slice(0, 12))} ...  ${KIND[b[0]] ?? '?'} ${TYPE[b[1]] ?? '?'}${st}`);
});

const report = (bytes) => { const r = new Uint8Array(64); r.set(bytes); return r; };
const write = (label, r) => { current = label; console.log(`TX ${label}: ${hex(r.slice(0, 12))} ...`); h.write([0x00, ...r]); };

/** [cmd, seq, flags, mode, frame(4, right-aligned)] like the known send command. */
const answerReport = (seq, mode) => { const r = report([0x15, seq, 0x00, mode]); r[7] = byte; return r; };
const steps = [];
steps.push(() => write('init firmware', report([0x01, 0x00])));
steps.push(() => write('init serial', report([0x01, 0x02])));
if (!has('--no-baseline')) {
  steps.push(() => { const r = report([0x12, 0x01, 0, 3]); r.set([0xff, 0x90], 6); write('baseline send FF 90 (known command)', r); });
}
modes.forEach((m, i) => steps.push(() => write(`SEND_ANSWER 0x${byte.toString(16)} mode=${m}`, answerReport(10 + i, m))));
// a second layout: answer byte directly after the header, no mode field
steps.push(() => { const r = report([0x15, 20, 0x00, 0x00]); r[4] = byte; write(`SEND_ANSWER 0x${byte.toString(16)} byte at [4]`, r); });

console.log(`Using ${dev.path}. Each step waits 1.5 s; everything the device sends is printed.`);
steps.forEach((fn, i) => setTimeout(fn, 300 + i * 1500));
setTimeout(() => { console.log('done'); h.close(); process.exit(0); }, 300 + steps.length * 1500 + 1000);

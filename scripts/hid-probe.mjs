#!/usr/bin/env node
// Hardware probe for the legacy Tridonic/Lunatone "DALI USB" (art. 24138923, HID 17b5:0020).
// The wire format used by DALI Scout comes from the python-dali driver and is UNVERIFIED; this
// script prints the raw 64-byte reports so it can be checked against a real device.
//
//   node scripts/hid-probe.mjs                      # list devices, init, dump traffic for 15 s
//   node scripts/hid-probe.mjs --seconds 60         # listen longer (sniff another master)
//   node scripts/hid-probe.mjs --send "FF 90"       # also send a 16-bit frame (broadcast query)
//   node scripts/hid-probe.mjs --send "FF 20" --twice
//   node scripts/hid-probe.mjs --path /dev/hidraw3  # pick a specific device
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const has = (name) => args.includes(name);
const seconds = Number(opt('--seconds', 15));
const sendHex = opt('--send');
const twice = has('--twice');

let HID;
try { HID = require('node-hid'); } catch (e) {
  console.error('Cannot load node-hid:', e.message.split('\n')[0]);
  console.error('Linux: install libusb-1.0 (apt install libusb-1.0-0) and run `npm install`.');
  process.exit(1);
}

const VID = 0x17b5, PID = 0x0020;
let all;
try { all = HID.devices().filter((d) => d.vendorId === VID); } catch (e) {
  // the native library is loaded lazily, so a missing libusb shows up here
  console.error('Cannot use node-hid:', e.message.split('\n')[0]);
  console.error('Linux: install libusb-1.0 (apt install libusb-1.0-0).');
  process.exit(1);
}
console.log(`Devices with vendor 0x17b5: ${all.length}`);
for (const d of all) {
  console.log(`  pid=0x${d.productId.toString(16).padStart(4, '0')} path=${d.path} product="${d.product}" serial="${d.serialNumber}" release=0x${d.release?.toString(16)} usagePage=${d.usagePage} usage=${d.usage}`);
}
const dev = opt('--path') ? { path: opt('--path') } : all.find((d) => d.productId === PID);
if (!dev) { console.error('No DALI USB (17b5:0020) found. Check cabling and the udev rule (docs/udev).'); process.exit(2); }

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
const KIND = { 0x01: 'INFO', 0x11: 'OBSERVED', 0x12: 'RESPONSE' };
const TYPE = { 0x71: 'NO_FRAME', 0x72: 'DALI8', 0x73: 'DALI16', 0x74: 'EDALI25', 0x76: 'DALI24', 0x77: 'STATUS' };
const t0 = Date.now();
let infoCount = 0;

const h = new HID.HID(dev.path);
h.on('error', (e) => { console.error('HID error:', e.message); process.exit(3); });
h.on('data', (buf) => {
  const b = Uint8Array.from(buf);
  const note = `${KIND[b[0]] ?? '?'} ${TYPE[b[1]] ?? '?'} frame=${hex(b.slice(2, 6))} interval=${(b[6] << 8) | b[7]} seq=${b[8]}`;
  const info = b[0] === 0x01
    ? (infoCount++ === 0 ? `   => firmware ${b[3]}.${b[4]}` : `   => serial ${hex(b.slice(1, 5)).replace(/ /g, '').toUpperCase()}`)
    : '';
  console.log(`+${String(Date.now() - t0).padStart(6)} ms  [${b.length}]  ${hex(b.slice(0, 12))} ...   ${note}${info}`);
});

const report = (bytes) => { const r = new Uint8Array(64); r.set(bytes); return r; };
const write = (label, r) => { console.log(`TX ${label}: ${hex(r.slice(0, 12))} ...`); h.write([0x00, ...r]); };

write('init firmware ', report([0x01, 0x00]));
setTimeout(() => write('init serial   ', report([0x01, 0x02])), 200);

if (sendHex) {
  const f = Uint8Array.from(sendHex.replace(/0x/gi, ' ').match(/[0-9a-f]{2}/gi).map((x) => parseInt(x, 16)));
  if (f.length !== 2 && f.length !== 3) { console.error('--send expects 2 or 3 bytes'); process.exit(4); }
  // [0]=0x12 send, [1]=seq, [2]=flags (0x20 = send twice), [3]=mode (3 = 16 bit, 6 = 24 bit), [4..7]=frame right-aligned
  const r = report([0x12, 0x01, twice ? 0x20 : 0x00, f.length === 2 ? 3 : 6]);
  r.set(f, 8 - f.length);
  setTimeout(() => write(`send ${hex(f)}${twice ? ' (twice)' : ''}`, r), 600);
}

console.log(`Listening for ${seconds} s ... (Ctrl-C to stop)`);
setTimeout(() => { h.close(); console.log('done'); process.exit(0); }, seconds * 1000);

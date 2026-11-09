#!/usr/bin/env node
// Experiment 2: can the legacy DALI USB answer a real query in time?
//
// Listens on the bus. Whenever it sees a 16-bit forward frame  <ADDR> <CMD>  that matches
// --addr/--cmd (default: the QUERY STATUS 0x90 to short address 1 -> forward byte 0x03, which your
// controller was already sending), it immediately writes a SEND_ANSWER report (0x15, byte) and
// prints how long that took:
//   host: time from receiving the query report to the write call returning,
//   bus : the device's own report of the answer ("OBSERVED DALI8") and the gap to the query.
// Watch your controller / commissioning tool: does it now show a device at that address?
//
//   node scripts/hid-answer-latency.mjs                  # answer 03 90 with 0x00 (status: all OK)
//   node scripts/hid-answer-latency.mjs --addr 01 --cmd 90 --byte 00
//   node scripts/hid-answer-latency.mjs --seconds 60
//
// Only command codes 0x01 and 0x15 are sent. Stop with Ctrl-C.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const addr = parseInt(opt('--addr', '03'), 16);
const cmd = parseInt(opt('--cmd', '90'), 16);
const byte = parseInt(opt('--byte', '00'), 16);
const seconds = Number(opt('--seconds', '30'));

let HID;
try { HID = require('node-hid'); } catch (e) { console.error('Cannot load node-hid:', e.message.split('\n')[0]); process.exit(1); }
const info = HID.devices().find((d) => d.vendorId === 0x17b5 && d.productId === 0x0020);
if (!info) { console.error('DALI USB (17b5:0020) not found'); process.exit(2); }
const h = new HID.HID(info.path);
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');
const report = (b) => { const r = new Array(64).fill(0); b.forEach((v, i) => { r[i] = v; }); return r; };
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000; // ms

let queryAt = 0, sentAt = 0, answered = 0, seen = 0;
h.on('data', (d) => {
  const t = now();
  const kind = d[0], type = d[1];
  if (kind === 0x11 && type === 0x73 && d[4] === addr && d[5] === cmd) {
    seen++;
    queryAt = t;
    h.write([0x00, ...report([0x15, byte])]);
    sentAt = now();
    answered++;
    console.log(`#${seen} query ${hex(d.slice(4, 6))} seen; answer ${byte.toString(16)} written after ${(sentAt - queryAt).toFixed(2)} ms (host)`);
  } else if (kind === 0x11 && type === 0x72) {
    console.log(`   device observed its answer ${hex(d.slice(5, 6))} ${(t - queryAt).toFixed(2)} ms after the query report (report interval field ${(d[6] << 8) | d[7]})`);
  } else if (kind === 0x11 && type === 0x73) {
    console.log(`   other frame ${hex(d.slice(4, 6))}`);
  } else if (kind === 0x15) {
    console.log(`   ack ${hex(d.slice(0, 4))}`);
  }
});
h.on('error', (e) => { console.error('HID error:', e.message); process.exit(3); });
h.write([0x00, ...report([0x01, 0x00])]);
console.log(`Waiting ${seconds} s for forward frame ${addr.toString(16)} ${cmd.toString(16)} ... answering with ${byte.toString(16)}`);
setTimeout(() => {
  console.log(`done: ${seen} queries seen, ${answered} answered`);
  h.close();
  process.exit(0);
}, seconds * 1000);

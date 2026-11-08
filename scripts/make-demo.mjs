// Generates examples/demo.dscap: a hand-written bus session (commissioning, control, queries, errors).
// Usage: node scripts/make-demo.mjs
import { writeFileSync } from 'node:fs';

const lines = [JSON.stringify({ format: 'dscap', version: 1 })];
let t = 1_000_000;
const add = (hex, gapMs, extra = {}) => {
  t += Math.round(gapMs * 1000);
  const bytes = hex.trim().split(/\s+/);
  lines.push(JSON.stringify({
    t, d: 'rx', k: bytes.length === 1 ? 'backward' : 'forward', b: bytes.length * 8,
    h: hex.toUpperCase(), s: 'demo', ...extra
  }));
};
const twice = (hex, gap = 30) => { add(hex, gap); add(hex, 18); };

// --- commissioning: initialise, randomise, binary search compare, program short address
twice('A5 00', 200); twice('A7 00', 60);
add('B1 00', 80); add('B3 80', 22); add('B5 00', 22); add('A9 00', 22); add('FF', 6);
add('B5 40', 30); add('A9 00', 22);               // no answer
add('B7 01', 30); add('B9 01', 25); add('FF', 6);
add('AB 00', 30); add('A1 00', 30);

// --- normal operation
add('FE 00', 1500);                                 // broadcast DAPC off
add('FE FE', 800);                                  // broadcast DAPC 254
add('00 80', 600); add('02 B4', 500);               // short 0 / 1 DAPC
add('01 A0', 400); add('FE', 5);                    // short 0 query actual level -> 254
add('03 A0', 400); add('B4', 6);                    // short 1 query actual level
add('01 90', 300); add('04', 5);                    // query status -> lamp arc power on
add('05 91', 300);                                  // query control gear present (no answer)
add('01 99', 300); add('08', 5);                    // device type 8
add('FF A0', 300);                                  // stray broadcast query: unanswered

// --- scene / group configuration (send-twice with DTR0)
add('A3 C8', 1000); twice('01 44'); // short 0: SET SCENE 4 = DTR0 200 (0x01 = short 0 S=1, 0x44)
twice('01 62');                      // ADD TO GROUP 2
add('85 14', 600);                  // group 2 GO TO SCENE 4
add('01 C0', 300); add('04', 5);    // query groups 0-7 -> bit 2

// --- DT8 colour: DTR2:DTR1 = 0x0FA0, ENABLE DT8, extended command
add('C3 A0', 1200); add('C5 0F', 15); add('C1 08', 15); add('01 E2', 15);
add('C1 08', 400); add('01 F8', 15);

// --- garbage
lines.push(JSON.stringify({ t: (t += 700_000), d: 'rx', k: 'error', b: 0, h: '', e: 'collision', s: 'demo' }));
add('01 02 03', 500);
add('FE 80', 400);

writeFileSync(new URL('../examples/demo.dscap', import.meta.url), lines.join('\n') + '\n');
console.log(`wrote ${lines.length - 1} frames`);

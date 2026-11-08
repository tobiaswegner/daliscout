import { renderToString as render } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CaptureSession, Simulation, makeFrame } from '@dali-scout/core';
import { App } from '../src/renderer/src/App';
import { Simulator } from '../src/renderer/src/Simulator';
import type { SimState } from '../src/shared';

/** SSR separates adjacent text nodes with comment markers; drop them so assertions read naturally. */
const renderToString = (el: ReactElement) => render(el).replace(/<!-- -->/g, '');

// Server-side rendering exercises every component's render path without needing a browser.

function simState(): SimState {
  const sim = new Simulation({ rng: () => 0.5 });
  sim.addGears(4, { deviceTypes: [] }, 0);
  const [a, b, c, d] = sim.gears;
  b!.forceLevel(60);
  c!.setFault({ lampFailure: true });
  d!.setFault({ offline: true, noAnswer: true });
  a!.s.groups = 0b101;
  a!.s.scenes[3] = 120;
  a!.s.actualLevel = 10;
  a!.s.fade = { startLevel: 10, targetLevel: 200, startUs: 0, durationUs: 1e6 };
  sim.addGear({ deviceTypes: [8] });        // unaddressed DT8
  return { active: true, gears: sim.snapshot(), maxGears: 65, speed: 1, paused: false };
}

const noop = async () => ({ ok: true as const });

describe('Simulator view', () => {
  it('renders tiles for every gear', () => {
    const html = renderToString(
      <Simulator sim={simState()} run={noop} active canSend recent={[]} />
    );
    expect(html).toContain('5 / 65 gears');
    expect(html).toContain('A0'); expect(html).toContain('A3');
    expect(html).toContain('no address');
    expect(html).toContain('DT8');
    expect(html).toContain('offline');
    expect(html).toContain('G0'); expect(html).toContain('G2');
    expect(html).toContain('Commission unaddressed (1)');
    expect(html).toContain('↗');                       // gear 0 is fading up
  });
  it('shows a start button while the virtual bus is not running', () => {
    const html = renderToString(<Simulator sim={{ ...simState(), active: false }} run={noop} active={false} canSend={false} recent={[]} />);
    expect(html).toContain('Start virtual bus');
    expect(html).not.toContain('Commission');
  });
  it('warns above 64 gears and while busy', () => {
    const sim = new Simulation();
    sim.addGears(65);
    const html = renderToString(
      <Simulator sim={{ active: true, gears: sim.snapshot(), maxGears: 65, speed: 2.5, paused: true, busy: 'Commissioning…' }}
        run={noop} active canSend recent={[]} />
    );
    expect(html).toContain('only 64 addresses');
    expect(html).toContain('Commissioning…');
    expect(html).toContain('Resume time');
    expect(html).toContain('2.5×');                    // unusual speed stays selectable
  });
  it('lists recent telegrams', () => {
    const s = new CaptureSession();
    s.push(makeFrame('0B A0', { ts: 0 }));
    s.push(makeFrame('FE', { ts: 6000 }));
    const html = renderToString(<Simulator sim={simState()} run={noop} active canSend recent={[...s.all()]} />);
    expect(html).toContain('QUERY ACTUAL LEVEL');
    expect(html).toContain('→ 254');
  });
});

describe('App', () => {
  it('renders with tabs and an empty capture', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Monitor'); expect(html).toContain('Simulator');
    expect(html).toContain('0 telegrams');
  });
});

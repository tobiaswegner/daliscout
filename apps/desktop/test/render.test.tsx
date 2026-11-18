import { renderToString as render } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { CaptureSession, Simulation, makeFrame } from '@dali-scout/core';
import { App } from '../src/renderer/src/App';
import { BookmarkPanel, HighlightPanel } from '../src/renderer/src/AnnotationPanels';
import { compileRules } from '../src/renderer/src/annotations';
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
  sim.addGear({ colour: 'rgb-ct' });        // unaddressed DT8
  return { active: true, gears: sim.snapshot(), maxGears: 65, speed: 1, paused: false };
}

const noop = async () => ({ ok: true as const });

describe('Simulator view', () => {
  it('renders tiles for every gear', () => {
    const html = renderToString(
      <Simulator sim={simState()} run={noop} active canSend total={0} rowAt={() => undefined} version={0} />
    );
    expect(html).toContain('5 / 65 gears');
    expect(html).toContain('A0'); expect(html).toContain('A3');
    expect(html).toContain('no address');
    expect(html).toContain('DT8');
    expect(html).toContain('RGB+CT');
    expect(html).toContain('offline');
    expect(html).toContain('G0'); expect(html).toContain('G2');
    expect(html).toContain('Commission unaddressed (1)');
    expect(html).toContain('↗');                       // gear 0 is fading up
  });
  it('renders the DT8 colour panel and the DT0 panel for the selected gear', async () => {
    const sim = new Simulation();
    sim.addGear({ colour: 'rgb-ct', shortAddress: 0 });
    sim.addGear({ deviceTypes: [0], shortAddress: 1 });
    const st: SimState = { active: true, gears: sim.snapshot(), maxGears: 65, speed: 1, paused: false };
    // selection is internal state; render the detail panels through the exported components
    const { ColourPanel, Dt0Panel } = await import('../src/renderer/src/Simulator');
    const colour = renderToString(<ColourPanel g={st.gears[0]!} />);
    expect(colour).toContain('DT8 RGB+CT');
    expect(colour).toContain('<svg');                  // CIE diagram
    expect(colour).toContain('type="range"');           // Tc slider
    expect(colour).toContain('153–370 mirek');
    const tc = renderToString(<ColourPanel g={{ id: 9, state: new Simulation().addGear({ colour: 'tc', shortAddress: 2 }).s }} />);
    expect(tc).not.toContain('<svg');                   // no xy: no diagram
    expect(renderToString(<Dt0Panel s={st.gears[1]!.state} />)).toContain('standard (logarithmic)');
    const unaddressed = renderToString(<ColourPanel g={{ id: 8, state: new Simulation().addGear({ colour: 'rgb' }).s }} />);
    expect(unaddressed).toContain('Commission this gear');
  });
  it('shows a start button while the virtual bus is not running', () => {
    const html = renderToString(<Simulator sim={{ ...simState(), active: false }} run={noop} active={false} canSend={false} total={0} rowAt={() => undefined} version={0} />);
    expect(html).toContain('Start virtual bus');
    expect(html).not.toContain('Commission');
  });
  it('warns above 64 gears and while busy', () => {
    const sim = new Simulation();
    sim.addGears(65);
    const html = renderToString(
      <Simulator sim={{ active: true, gears: sim.snapshot(), maxGears: 65, speed: 2.5, paused: true, busy: 'Commissioning…' }}
        run={noop} active canSend total={0} rowAt={() => undefined} version={0} />
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
    const html = renderToString(<Simulator sim={simState()} run={noop} active canSend total={s.length} rowAt={(i) => s.at(i)} version={1} />);
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

describe('find, highlight and bookmarks', () => {
  it('shows the find bar and the new toolbar buttons', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Find (Ctrl+F)'); expect(html).toContain('Highlight'); expect(html).toContain('Bookmarks');
  });
  it('renders rules and bookmarks', () => {
    const rules = [{ id: 1, enabled: true, color: '#fde68a', filter: { text: 'scene' } }];
    expect(renderToString(<HighlightPanel rules={rules} onChange={() => {}} />)).toContain('value="scene"');
    const marks = new Map([[7, 'the odd one']]);
    const html = renderToString(<BookmarkPanel marks={marks} bySeq={() => undefined} onJump={() => {}}
      onNote={() => {}} onRemove={() => {}} onClearAll={() => {}} />);
    expect(html).toContain('#7'); expect(html).toContain('the odd one');
  });
  it('colours the first matching enabled rule', () => {
    const row = { seq: 1, frame: { dir: 'rx', data: new Uint8Array([0x0a, 0x80]), ts: 0 },
      decoded: { target: 'Short 5', command: 'DAPC', params: [], summary: 'x', warnings: [], expectsAnswer: false } } as never;
    const c = compileRules([
      { id: 1, enabled: false, color: '#111111', filter: { text: 'dapc' } },
      { id: 2, enabled: true, color: '#222222', filter: { text: 'dapc' } },
      { id: 3, enabled: true, color: '#333333', filter: { text: 'dapc' } }], 0);
    expect(c(row)).toBe('#222222');
  });
});

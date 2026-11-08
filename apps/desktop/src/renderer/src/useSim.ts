import { useCallback, useEffect, useState } from 'react';
import type { SimCommand, SimCommandResult, SimState } from '../../shared';

const EMPTY: SimState = { active: false, gears: [], maxGears: 65, speed: 1, paused: false };

export function useSim() {
  const [state, setState] = useState<SimState>(EMPTY);
  useEffect(() => window.dali.onSimState(setState), []);
  const run = useCallback((c: SimCommand): Promise<SimCommandResult> => window.dali.simCommand(c), []);
  return { state, run };
}

// Picks the engine behind the Live Ink UI: the scripted fake when the dev flag is on
// (localStorage 'goodink:live-fake' = '1'), otherwise the real LiveEngine adapted to LiveUiEngine.
import type { NotebookSession } from '../../engine/session';
import type { LiveStatus, LiveUiEngine } from './engineApi';

export const fakeOn = () => {
  try {
    return localStorage.getItem('goodink:live-fake') === '1';
  } catch {
    return false;
  }
};

/** An engine that does nothing (no real engine yet, or it failed to load): the UI stays quiet. */
export function nullEngine(): LiveUiEngine {
  const st: LiveStatus = { mode: 'off', state: 'idle', lastMs: null, tokens: 0, aiReady: false };
  return {
    kind: 'real',
    status: () => st,
    onStatus: () => () => undefined,
    setMode: () => undefined,
    onDecorations: () => () => undefined,
    insightAt: () => null,
    onInsight: () => () => undefined,
    recheck: async () => null,
    hint: async () => {
      throw new Error('Live check is not available.');
    },
    ask: async () => {
      throw new Error('Live check is not available.');
    },
  };
}

// the real engine is optional at build time while it is being written
const real = import.meta.glob('../engine.ts') as Record<string, () => Promise<Record<string, unknown>>>;

export async function createUiEngine(s: NotebookSession): Promise<LiveUiEngine> {
  if (fakeOn()) return (await import('./fakeEngine')).createFakeEngine(s);
  const load = real['../engine.ts'];
  if (!load) return nullEngine();
  try {
    const mod = await load();
    const make = mod.createUiEngine as ((s: NotebookSession) => LiveUiEngine | Promise<LiveUiEngine>) | undefined;
    if (make) return await make(s);
    const { adaptLiveEngine } = await import('./realAdapter');
    return (await adaptLiveEngine(mod, s)) ?? nullEngine();
  } catch (e) {
    console.warn('live engine failed to load', e);
    return nullEngine();
  }
}

// Adapts the real LiveEngine (src/renderer/live/engine.ts) to the UI's LiveUiEngine.
// Filled in against the engine's actual API once it lands.
import type { NotebookSession } from '../../engine/session';
import type { LiveUiEngine } from './engineApi';

export async function adaptLiveEngine(_mod: Record<string, unknown>, _s: NotebookSession): Promise<LiveUiEngine | null> {
  return null;
}

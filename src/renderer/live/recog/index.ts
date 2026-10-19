// Live ink recognition (RecogModule in ../contract): page ink -> blocks and lines, and on-device
// recognition of a block with the Windows ink recogniser plus a 2-D math layout pass.
import { api } from '../../lib/api';
import type { RecogModule } from '../contract';
import { groupStrokes } from './geom';
import { inkBackend, makeRecognizer, type RecogBackend } from './recognize';
import { hmerBackend } from './hmer';

let warmed = false;

export const groupInk: RecogModule['groupInk'] = (pageId, strokes) => {
  if (!warmed) {
    // load the recogniser (~0.5 s, once) while the user is still writing
    warmed = true;
    api.inkAnalyze([]).catch(() => {});
  }
  return groupStrokes(pageId, strokes);
};

/**
 * The free local math model (Pix2Text MFR, MIT) reads math lines when it is installed (Settings ->
 * AI); without it the Windows recogniser reads alone. Checked once, and again after an install.
 */
let modelReady: Promise<boolean> | null = null;
export const recheckModel = () => (modelReady = api.hmerStatus().then((s) => !!s.models.find((m) => m.id === s.defaultModel)?.installed).catch(() => false));
const model = hmerBackend((strokes, opts) => api.hmerRecognize(strokes, opts), { topK: 5, beam: 5 });
const localModel: RecogBackend = {
  ...model,
  async recognize(lines) {
    return (await (modelReady ?? recheckModel())) ? model.recognize(lines) : lines.map(() => null);
  },
};

export const recognizeBlock: RecogModule['recognizeBlock'] = makeRecognizer([inkBackend((strokes, opts) => api.inkAnalyze(strokes, opts)), localModel]);

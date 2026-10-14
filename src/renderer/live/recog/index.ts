// Live ink recognition (RecogModule in ../contract): page ink -> blocks and lines, and on-device
// recognition of a block with the Windows ink recogniser plus a 2-D math layout pass.
import { api } from '../../lib/api';
import type { RecogModule } from '../contract';
import { groupStrokes } from './geom';
import { inkBackend, makeRecognizer } from './recognize';

let warmed = false;

export const groupInk: RecogModule['groupInk'] = (pageId, strokes) => {
  if (!warmed) {
    // load the recogniser (~0.5 s, once) while the user is still writing
    warmed = true;
    api.inkAnalyze([]).catch(() => {});
  }
  return groupStrokes(pageId, strokes);
};

export const recognizeBlock: RecogModule['recognizeBlock'] = makeRecognizer([inkBackend((strokes, opts) => api.inkAnalyze(strokes, opts))]);

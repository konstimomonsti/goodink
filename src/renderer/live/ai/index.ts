// The live AI layer: block checks with independent verification, streaming tutor answers, voice.
export { LiveAi, NoAiProvider, type AiHealth, type LiveAiOptions } from './service';
export { judgeLine, type Caller, type CallOpts, type CallResult, type CropImage, type JudgeInput, type JudgeResult } from './check';
export { mergeCheck, enforceRedPolicy, CONFIDENT_READING, CONFIDENT_CAS, type AiOutcome, type AiLineOutcome, type LiveBlockCheck, type LocalResult } from './merge';
export { parseAiJudge, parseAiVerify, parseLooseJson, mapSpan, alignLines, similarity, JUDGE_SCHEMA, VERIFY_SCHEMA, type AiJudge, type AiVerify } from './json';
export { streamAsk, askTurns, Pacer, type StreamAskOpts, type StreamAskResult } from './stream';
export { QUICK_ACTIONS, LADDER, questionFor, splitFollowUps, type HintLevel, type QuickActionId } from './prompts';
export { transcribeWith, toWav16k, encodeWav, audioProvider, LocalDictationNeeded } from './voice';
export { cropBlockImage, cropGeometry, b64 } from './crop';
export { pickModel, effortFor, providerOrder, choiceFor, Breaker, TokenMeter, imageTokens, type Tier } from './router';
export { blockKey, hash53 } from './hash';
export { POLICY, priceOf } from './policy';

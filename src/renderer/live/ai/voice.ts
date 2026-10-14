// Speech to text for the ask box. Providers that take audio input in chat (Gemini through its
// OpenAI-compatible API, OpenAI audio chat models, OpenRouter) transcribe a short clip; Claude has
// no audio input, so the UI falls back to on-device dictation (recog module: api.speechStart/Stop).
// The backend passes request bodies as text, so audio goes as base64 WAV inside the JSON body
// (a multipart upload to /audio/transcriptions would need a binary-body path in ai_fetch).
import { aiFailure, complete, type AiChoice, type AiSettings, type ProviderId } from '../../lib/ai';
import { b64 } from './crop';
import { POLICY, TRANSCRIBE_SYSTEM } from './policy';

export class LocalDictationNeeded extends Error {
  constructor() {
    super('Your AI provider cannot listen to audio. Use on-device dictation instead.');
    this.name = 'LocalDictationNeeded';
  }
}

const AUDIO_PROVIDERS = POLICY.audioProviders;

/** The first ready provider that can transcribe, the user's own first. */
export function audioProvider(order: ProviderId[]): ProviderId | null {
  return order.find((p) => AUDIO_PROVIDERS.includes(p)) ?? null;
}

/** Audio models to try per provider when the chat model itself cannot listen. */
export const AUDIO_MODELS = POLICY.audioModels;

/** Encode mono 16-bit PCM samples as a WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return out;
}

/** Any recorded clip (webm/opus from MediaRecorder) as 16 kHz mono WAV, base64. */
export async function toWav16k(audio: Blob): Promise<string> {
  const rate = 16000;
  const ctx = new OfflineAudioContext(1, rate, rate);
  const buf = await ctx.decodeAudioData(await audio.arrayBuffer());
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return b64(encodeWav(mono, buf.sampleRate));
}


export async function transcribeWith(c: AiChoice, wavB64: string, signal?: AbortSignal, run: typeof complete = complete): Promise<{ text: string; usage: { input: number; output: number } | null }> {
  const models = [c.model, ...(AUDIO_MODELS[c.provider] ?? [])];
  let last: unknown;
  for (const model of models) {
    try {
      const r = await run({ ...c, model, effort: '' }, { system: TRANSCRIBE_SYSTEM, audio: { data: wavB64, format: 'wav' }, turns: [{ role: 'user', text: 'Transcribe this recording.' }], maxTokens: POLICY.budget.transcribe, signal });
      return { text: r.text.trim(), usage: r.usage };
    } catch (e) {
      last = e;
      const k = aiFailure(e);
      if (k !== 'model' && k !== 'bad-request') throw e;
    }
  }
  throw last;
}

export const canTranscribe = (ai: AiSettings, order: ProviderId[]) => !!audioProvider(order) && ai.keys.length > 0;

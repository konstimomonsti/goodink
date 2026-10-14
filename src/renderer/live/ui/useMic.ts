// Press to talk, press again to stop. Draws a live level meter into a canvas (no React state per
// frame) and turns speech into text with the best path available:
//   1. local dictation from the backend (api.speechStart), with live partial text
//   2. the engine's transcription of the recorded clip
//   3. the web view's own speech recognition
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../lib/store';
import type { LiveUiEngine } from './engineApi';

type Dictation = { stop(): Promise<string> };
type SpeechApi = { speechStart?: (onPartial: (text: string) => void) => Promise<Dictation> };
type WebSpeech = { new (): { lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; start(): void; stop(): void } };

export type MicState = 'idle' | 'starting' | 'recording' | 'transcribing';
type Live = { stream: MediaStream; ctx: AudioContext; raf: number; rec: MediaRecorder | null; chunks: Blob[]; dict: Dictation | null; web: InstanceType<WebSpeech> | null };

export function useMic(engine: LiveUiEngine | null, onText: (text: string, final: boolean) => void) {
  const [state, setState] = useState<MicState>('idle');
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const live = useRef<Live | null>(null);
  const starting = useRef(false);
  const stopAsked = useRef(false);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const textCb = useRef(onText);
  textCb.current = onText;

  const draw = useCallback((an: AnalyserNode, buf: Uint8Array<ArrayBuffer>, hist: Float32Array) => {
    const c = canvas.current;
    const L = live.current;
    if (!L) return;
    L.raf = requestAnimationFrame(() => draw(an, buf, hist));
    if (!c) return;
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 4.2);
    // scrolling history of levels, newest on the right
    hist.copyWithin(0, 1);
    hist[hist.length - 1] = level;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    g.fillStyle = getComputedStyle(c).color;
    const bw = 3 * dpr, gap = 2 * dpr;
    const n = Math.min(hist.length, Math.floor(W / (bw + gap)));
    for (let k = 0; k < n; k++) {
      const v = hist[hist.length - n + k];
      const h = Math.max(2 * dpr, v * H * 0.92);
      const x = k * (bw + gap);
      g.beginPath();
      g.roundRect(x, (H - h) / 2, bw, h, bw / 2);
      g.fill();
    }
  }, []);

  const cleanup = useCallback(() => {
    const L = live.current;
    if (!L) return;
    cancelAnimationFrame(L.raf);
    L.stream.getTracks().forEach((t) => t.stop());
    void L.ctx.close().catch(() => undefined);
    live.current = null;
  }, []);

  useEffect(() => () => {
    live.current?.web?.stop();
    void live.current?.dict?.stop().catch(() => undefined);
    cleanup();
  }, [cleanup]);

  const start = useCallback(async () => {
    if (live.current || starting.current) return;
    starting.current = true;
    stopAsked.current = false;
    setState('starting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      starting.current = false;
      setState('idle');
      toast('No microphone available. Check microphone access in Windows privacy settings.', { kind: 'error', ms: 6000 });
      return;
    }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const L: Live = { stream, ctx, raf: 0, rec: null, chunks: [], dict: null, web: null };
    live.current = L;
    const speech = (api as unknown as SpeechApi).speechStart;
    const Web = (window as unknown as { SpeechRecognition?: WebSpeech; webkitSpeechRecognition?: WebSpeech }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: WebSpeech }).webkitSpeechRecognition;
    try {
      if (speech) L.dict = await speech((t) => textCb.current(t, false));
    } catch {
      L.dict = null;
    }
    if (!L.dict && engine?.transcribe) {
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      rec.ondataavailable = (e) => e.data.size && L.chunks.push(e.data);
      rec.start(500);
      L.rec = rec;
    } else if (!L.dict && Web) {
      const w = new Web();
      w.lang = navigator.language || 'en-US';
      w.interimResults = true;
      w.continuous = true;
      w.onresult = (e) => textCb.current([...Array.from(e.results)].map((r) => r[0].transcript).join(' '), false);
      w.onerror = () => undefined;
      w.start();
      L.web = w;
    }
    draw(an, new Uint8Array(an.fftSize), new Float32Array(64));
    starting.current = false;
    setState('recording');
    // released before the microphone was ready: stop right away
    if (stopAsked.current) void stopRef.current();
  }, [draw, engine]);

  const stop = useCallback(async () => {
    const L = live.current;
    if (!L) {
      if (starting.current) stopAsked.current = true;
      return;
    }
    setState('transcribing');
    try {
      if (L.dict) textCb.current(await L.dict.stop(), true);
      else if (L.rec && engine?.transcribe) {
        const rec = L.rec;
        await new Promise<void>((r) => {
          rec.onstop = () => r();
          rec.stop();
        });
        cleanup();
        const text = await engine.transcribe(new Blob(L.chunks, { type: 'audio/webm' }));
        textCb.current(text, true);
      } else if (L.web) {
        L.web.stop();
        textCb.current('', true);
      } else toast('Voice input is not available on this PC yet. Type your question instead.', { ms: 5000 });
    } catch {
      toast('Could not turn the recording into text.', { kind: 'error' });
    } finally {
      cleanup();
      setState('idle');
    }
  }, [cleanup, engine]);

  stopRef.current = stop;
  return { state, start, stop, toggle: () => (live.current ? stop() : start()), canvas };
}

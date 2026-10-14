// YouTube as a Study resource: the video's captions become the text the AI makes cards from.
// Captions come from the same player API the YouTube Android app uses (the web page's caption links
// now need a browser token). If a video has no readable captions, Google Gemini can watch the video
// itself (see generateCardsFromVideo in lib/ai).
import { invoke } from '@tauri-apps/api/core';

type Res = { status: number; headers: [string, string][]; body: string };
const fetchText = (url: string, init: { method?: string; headers?: [string, string][]; body?: string } = {}) =>
  invoke<Res>('ai_fetch', { req: { url, method: init.method ?? 'GET', headers: init.headers ?? [], body: init.body ?? null, secret: null } });

/** The video id of any common YouTube link (watch, youtu.be, shorts, live, embed, m.), or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id: string | null = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v') ?? (/^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname)?.[1] ?? null);
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const youtubeUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** Title and channel from YouTube's public oEmbed endpoint. */
export async function youtubeInfo(id: string): Promise<{ title: string; author: string }> {
  const r = await fetchText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeUrl(id))}`);
  if (r.status === 401 || r.status === 403) throw new Error('This video is private or cannot be embedded.');
  if (r.status >= 400) throw new Error('YouTube does not know this video. Check the link.');
  const j = JSON.parse(r.body) as { title?: string; author_name?: string };
  return { title: j.title ?? 'YouTube video', author: j.author_name ?? '' };
}

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string; // 'asr' = generated from speech
}

const ANDROID = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34 };

async function captionTracks(id: string): Promise<Track[]> {
  const r = await fetchText('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: [
      ['content-type', 'application/json'],
      ['user-agent', `com.google.android.youtube/${ANDROID.clientVersion} (Linux; U; Android 14) gzip`],
    ],
    body: JSON.stringify({ context: { client: { ...ANDROID, hl: 'en' } }, videoId: id }),
  });
  if (r.status >= 400) return [];
  const j = JSON.parse(r.body) as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } } };
  return j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

/** The spoken language's own captions: hand-made ones first, then the automatic ones. */
function pickTrack(tracks: Track[]): Track | undefined {
  const spoken = tracks.find((t) => t.kind === 'asr')?.languageCode;
  const manual = tracks.filter((t) => t.kind !== 'asr');
  return (
    (spoken && manual.find((t) => t.languageCode === spoken || t.languageCode.startsWith(`${spoken}-`))) ||
    tracks.find((t) => t.kind === 'asr') ||
    manual.find((t) => t.languageCode.startsWith('en')) ||
    manual[0]
  );
}

const stamp = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};

/** The transcript with a [m:ss] mark about every 30 seconds, or null when YouTube offers none. */
export async function youtubeTranscript(id: string): Promise<{ text: string; language: string; automatic: boolean } | null> {
  const track = pickTrack(await captionTracks(id));
  if (!track) return null;
  const r = await fetchText(track.baseUrl, { headers: [['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)']] });
  if (r.status >= 400 || !r.body.trim()) return null;
  const doc = new DOMParser().parseFromString(r.body, 'text/xml');
  // format 3 uses <p t="ms">, the older format <text start="s">
  const cues = [...doc.querySelectorAll('p, text')]
    .map((el) => ({ t: el.hasAttribute('t') ? +el.getAttribute('t')! : +(el.getAttribute('start') ?? 0) * 1000, s: (el.textContent ?? '').replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.s);
  if (!cues.length) return null;
  const out: string[] = [];
  let block = -1;
  for (const c of cues) {
    const b = Math.floor(c.t / 30_000);
    if (b !== block) {
      out.push(`\n[${stamp(c.t)}] ${c.s}`);
      block = b;
    } else out[out.length - 1] += ` ${c.s}`;
  }
  return { text: out.join('').trim(), language: track.languageCode, automatic: track.kind === 'asr' };
}

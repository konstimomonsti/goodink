// Finding sources on the web: DuckDuckGo's HTML results for websites, Wikipedia's own search API, and
// YouTube's search. None of them needs a key. Requests run in the backend (no CORS limits there).
import { invoke } from '@tauri-apps/api/core';

export interface Found {
  kind: 'web' | 'wikipedia' | 'youtube';
  title: string;
  url: string;
  /** domain, or the channel for videos */
  source: string;
  snippet: string;
  /** YouTube: length like 12:34 */
  duration?: string;
}

type Res = { status: number; headers: [string, string][]; body: string };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const get = (url: string, init: { method?: string; headers?: [string, string][]; body?: string } = {}) =>
  invoke<Res>('ai_fetch', { req: { url, method: init.method ?? 'GET', headers: [['user-agent', UA], ...(init.headers ?? [])], body: init.body ?? null, secret: null } });

const domain = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

const BROWSER: [string, string][] = [['accept', 'text/html,application/xhtml+xml'], ['accept-language', `${navigator.language || 'en-US'},en;q=0.8`]];

/** Websites via DuckDuckGo. It sometimes answers automated requests with a check page; then its other
 *  address is tried once more, and if that fails too the caller reports websites as not answering. */
export async function searchWeb(q: string, max = 8): Promise<Found[]> {
  const tries = [
    () => get('https://html.duckduckgo.com/html/', { method: 'POST', headers: [...BROWSER, ['content-type', 'application/x-www-form-urlencoded']], body: `q=${encodeURIComponent(q)}` }),
    () => get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: BROWSER }),
  ];
  for (const [k, attempt] of tries.entries()) {
    if (k) await new Promise((r) => setTimeout(r, 1500));
    const r = await attempt();
    const found = r.status < 300 ? parseDuck(r.body, max) : [];
    if (found.length) return found;
  }
  throw new Error('DuckDuckGo did not answer');
}

function parseDuck(html: string, max: number): Found[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: Found[] = [];
  for (const el of doc.querySelectorAll('.result')) {
    if (el.classList.contains('result--ad')) continue;
    const a = el.querySelector<HTMLAnchorElement>('a.result__a');
    if (!a) continue;
    let href = a.getAttribute('href') ?? '';
    // DuckDuckGo wraps links as //duckduckgo.com/l/?uddg=<the real address>
    const wrapped = /[?&]uddg=([^&]+)/.exec(href);
    if (wrapped) href = decodeURIComponent(wrapped[1]);
    if (href.startsWith('//')) href = `https:${href}`;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com|youtube\.com\/watch|youtu\.be/.test(href)) continue;
    out.push({ kind: 'web', title: clean(a.textContent), url: href, source: domain(href), snippet: clean(el.querySelector('.result__snippet')?.textContent) });
    if (out.length >= max) break;
  }
  return out;
}

export async function searchWikipedia(q: string, lang = 'en', max = 3): Promise<Found[]> {
  const l = /^[a-z]{2,3}$/.test(lang) ? lang : 'en';
  const r = await get(`https://${l}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${max}&srsearch=${encodeURIComponent(q)}`);
  if (r.status >= 400) return [];
  const j = JSON.parse(r.body) as { query?: { search?: { title: string; snippet: string }[] } };
  return (j.query?.search ?? []).map((x) => ({
    kind: 'wikipedia',
    title: x.title,
    url: `https://${l}.wikipedia.org/wiki/${encodeURIComponent(x.title.replace(/ /g, '_'))}`,
    source: `${l}.wikipedia.org`,
    snippet: clean(new DOMParser().parseFromString(x.snippet, 'text/html').body.textContent),
  }));
}

type Runs = { runs?: { text: string }[]; simpleText?: string };
const text = (t?: Runs) => clean(t?.simpleText ?? t?.runs?.map((r) => r.text).join(''));

/** Every videoRenderer in YouTube's search data, in order. */
function videos(data: unknown, max: number): Found[] {
  const out: Found[] = [];
  const walk = (o: unknown) => {
    if (out.length >= max || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const v = (o as { videoRenderer?: { videoId: string; title?: Runs; longBylineText?: Runs; ownerText?: Runs; lengthText?: Runs; detailedMetadataSnippets?: { snippetText?: Runs }[]; descriptionSnippet?: Runs } }).videoRenderer;
    if (v?.videoId) {
      out.push({
        kind: 'youtube',
        title: text(v.title),
        url: `https://www.youtube.com/watch?v=${v.videoId}`,
        source: text(v.longBylineText ?? v.ownerText),
        snippet: text(v.detailedMetadataSnippets?.[0]?.snippetText ?? v.descriptionSnippet),
        duration: text(v.lengthText) || undefined,
      });
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(data);
  return out;
}

export async function searchYouTube(q: string, max = 6): Promise<Found[]> {
  // YouTube's own search API (what its website calls); the results page is the fallback
  const r = await get('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20261009.01.00', hl: 'en' } }, query: q }),
  });
  let found = r.status < 400 ? videos(JSON.parse(r.body), max) : [];
  if (!found.length) {
    const page = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { headers: [['accept-language', 'en']] });
    const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(page.body);
    if (m) found = videos(JSON.parse(m[1]), max);
  }
  return found;
}

/** Search everything chosen for every query; duplicates are dropped. Failures of one source don't stop the others. */
export async function findSources(queries: string[], opts: { web: boolean; wikipedia: boolean; youtube: boolean; lang: string }, onProgress: (msg: string) => void) {
  const all: Found[] = [];
  const seen = new Set<string>();
  const failed = new Set<string>();
  for (const [i, q] of queries.entries()) {
    onProgress(`Searching${queries.length > 1 ? ` (${i + 1} of ${queries.length})` : ''}: “${q}”…`);
    const jobs: [string, Promise<Found[]>][] = [];
    if (opts.web) jobs.push(['websites', searchWeb(q)]);
    if (opts.wikipedia) jobs.push(['Wikipedia', searchWikipedia(q, opts.lang)]);
    if (opts.youtube) jobs.push(['YouTube', searchYouTube(q)]);
    for (const [name, job] of jobs) {
      const list = await job.catch(() => (failed.add(name), [] as Found[]));
      for (const f of list) {
        // a video's id is in its query string, so YouTube links are compared whole
        const key = f.kind === 'youtube' ? f.url : f.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
        if (f.title && !seen.has(key)) {
          seen.add(key);
          all.push(f);
        }
      }
    }
  }
  return { found: all, failed: [...failed] };
}

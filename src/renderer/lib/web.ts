// Reading web pages for the in-app reader and for making flashcards. Pages are fetched by the
// backend (no CORS limits) and reduced to their readable text; scripts and page furniture are dropped.
import { invoke } from '@tauri-apps/api/core';

export interface PageText {
  title: string;
  /** readable text; "## " starts a heading line, "- " a list item */
  text: string;
}

export async function fetchPage(url: string): Promise<PageText> {
  const r = await invoke<{ status: number; headers: [string, string][]; body: string }>('ai_fetch', {
    req: { url, method: 'GET', headers: [['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'], ['accept', 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'], ['accept-language', `${navigator.language || 'en-US'},en;q=0.8`]], body: null, secret: null },
  });
  if (r.status === 401 || r.status === 403 || r.status === 429) throw new Error('This site does not allow a reader view. Open the original page in a goodink window instead.');
  if (r.status >= 400) throw new Error(`The page answered with error ${r.status}.`);
  const type = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  if (/pdf/i.test(type)) throw new Error('This link is a PDF. Download it and import it as a PDF instead.');
  if (!/html|xml/i.test(type)) return { title: url, text: r.body.trim() };
  const doc = new DOMParser().parseFromString(r.body, 'text/html');
  doc.querySelectorAll('script, style, noscript, nav, footer, header, aside, form, svg, iframe, template').forEach((el) => el.remove());
  const root = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
  const lines: string[] = [];
  root?.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote, dt, dd, figcaption').forEach((el) => {
    if (el.querySelector('p, li, td')) return; // keep the innermost block only
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (t) lines.push(/^H\d$/.test(el.tagName) ? `\n## ${t}` : el.tagName === 'LI' ? `- ${t}` : t);
  });
  const text = (lines.length ? lines.join('\n') : root?.textContent?.replace(/\s+\n/g, '\n') ?? '').trim();
  return { title: doc.querySelector('title')?.textContent?.trim() || url, text };
}

export const domainOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
};

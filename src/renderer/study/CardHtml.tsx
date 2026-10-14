// A card side as Anki shows it: the note type's HTML and styling, in a shadow root so the card's CSS
// cannot touch goodink and goodink's cannot touch the card. HTML is sanitized (no scripts or event
// handlers), formulas are typeset with KaTeX, {{type:…}} becomes an answer box, links open in the browser.
import { useEffect, useLayoutEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/contrib/mhchem';
import katexCss from 'katex/dist/katex.min.css?inline';
import { extractDisplay, mathParts } from '../ui/Math';
import { TYPE_MARK } from './notetypes';
import { api } from '../lib/api';

const BASE = `
:host { display: block; color: var(--c-text); --card-text: var(--c-text); --card-accent: var(--c-accent); }
.card { overflow-wrap: anywhere; }
.card img { max-width: 100%; height: auto; }
.card hr { border: 0; border-top: 1px solid var(--c-border); margin: 1.2em auto; max-width: 560px; }
.card a { color: var(--c-accent); }
.card table { border-collapse: collapse; margin: 0 auto; }
.card td, .card th { border: 1px solid var(--c-border); padding: 4px 8px; }
.card audio { display: block; margin: 8px auto; }
.card details.hint { display: inline-block; }
.card details.hint summary { cursor: pointer; color: var(--c-accent); font-size: .8em; }
.card .katex-display { margin: .6em 0; }
.card ul, .card ol { display: inline-block; text-align: left; }
input.typeans { display: block; width: min(100%, 520px); margin: 16px auto 0; font: inherit; font-size: 20px; text-align: center;
  padding: 8px 12px; border: 1px solid var(--c-border-input); border-radius: 10px; background: var(--c-surface); color: var(--c-text); }
input.typeans:focus { outline: 2px solid var(--c-focus); outline-offset: 1px; }
.typeans-result { font-family: var(--font-mono); font-size: .9em; margin-top: 12px; }
.typeans-good { background: color-mix(in srgb, var(--c-success) 25%, transparent); }
.typeans-bad { background: color-mix(in srgb, var(--c-danger) 25%, transparent); }
.typeans-missing { background: color-mix(in srgb, var(--c-text-muted) 22%, transparent); }
.typeans-arrow { color: var(--c-text-muted); }
`;

const SLOT = '<span data-typeans="1"></span>';

export function sanitizeCard(html: string) {
  return DOMPurify.sanitize(html.split(TYPE_MARK).join(SLOT), { ADD_TAGS: ['audio', 'source', 'details', 'summary'], ADD_ATTR: ['controls', 'data-typeans'], FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'button', 'iframe'] });
}

/** Typeset $…$, \(…\), $$…$$ and \[…\] in the text of a tree. */
export function typesetIn(root: ParentNode) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/[$\\]/.test(n.nodeValue ?? '') && !(n.parentElement?.closest('.katex, code, pre'))) nodes.push(n as Text);
  for (const node of nodes) {
    const { text, blocks } = extractDisplay(node.nodeValue ?? '');
    const parts = mathParts(text, blocks);
    if (!parts.some((p) => p.kind === 'math')) continue;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (p.kind === 'text') frag.append(p.v);
      else {
        const span = document.createElement('span');
        try {
          span.innerHTML = katex.renderToString(p.v, { displayMode: p.display, throwOnError: false, output: 'htmlAndMathml' });
        } catch {
          span.textContent = p.v;
        }
        frag.append(span);
      }
    }
    node.replaceWith(frag);
  }
}

export function CardHtml({
  html,
  css,
  className = '',
  autoplay = false,
  onTypeEnter,
  onTyped,
  label = 'Card',
}: {
  html: string;
  css: string;
  className?: string;
  autoplay?: boolean;
  /** Enter in the answer box */
  onTypeEnter?: (typed: string) => void;
  onTyped?: (typed: string) => void;
  label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onTypeEnter, onTyped });
  cb.current = { onTypeEnter, onTyped };

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${katexCss}\n${BASE}\n${css}</style><div class="card">${sanitizeCard(html)}</div>`;
    typesetIn(root);
    for (const slot of root.querySelectorAll('[data-typeans]')) {
      const input = document.createElement('input');
      input.className = 'typeans';
      input.setAttribute('aria-label', 'Type the answer');
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.addEventListener('input', () => cb.current.onTyped?.(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          cb.current.onTypeEnter?.(input.value);
        }
      });
      slot.replaceWith(input);
      requestAnimationFrame(() => input.focus());
    }
    if (autoplay) void root.querySelector('audio')?.play().catch(() => undefined);
  }, [html, css, autoplay]);

  // links in a card open in the browser, never inside goodink's window
  useEffect(() => {
    const root = host.current?.shadowRoot;
    if (!root) return;
    const onClick = (e: Event) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      if (/^https:\/\//i.test(a.href)) void api.openUrl(a.href);
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, []);

  return <div ref={host} className={`card-html ${className}`} role="group" aria-label={label} />;
}

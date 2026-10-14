// Streamed AI text: Markdown-lite with KaTeX, rendered as it arrives. Unclosed math is held back
// until its closing delimiter arrives, so half a formula never flashes as raw LaTeX.
import { Markdown } from '../../editor/AiDialogs';

export function settledText(text: string, streaming: boolean) {
  if (!streaming) return text;
  let t = text;
  if ((t.match(/\$\$/g) ?? []).length % 2) t = t.slice(0, t.lastIndexOf('$$'));
  const singles = t.replace(/\$\$/g, '').match(/(?<!\\)\$/g)?.length ?? 0;
  if (singles % 2) t = t.slice(0, t.lastIndexOf('$'));
  if ((t.match(/\\\(/g) ?? []).length > (t.match(/\\\)/g) ?? []).length) t = t.slice(0, t.lastIndexOf('\\('));
  if ((t.match(/\*\*/g) ?? []).length % 2) t = t.slice(0, t.lastIndexOf('**')) + t.slice(t.lastIndexOf('**') + 2);
  return t;
}

export function StreamText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className={`live-stream ${streaming ? 'is-streaming' : ''}`}>
      <Markdown text={settledText(text, streaming)} />
    </div>
  );
}

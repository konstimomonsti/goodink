// Live ink reading pass: 2-D layout (fractions, exponents, roots, subscripts), confusable fixes
// from context and glyph shape, linear text / LaTeX / stroke-mapped tokens, k-best probabilities
// and fusing two backends. The Windows recogniser is emulated from the synthetic glyph labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// the app's modules import each other without extensions (Vite style); resolve those to .ts here
registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (/^\.\.?\//.test(spec) && ctx.parentURL?.endsWith('.ts'))
        for (const ext of ['.ts', '/index.ts'])
          try {
            return next(spec + ext, ctx);
          } catch {
            /* next */
          }
      throw e;
    }
  },
});

const { makeRecognizer, inkBackend, fuse } = await import('../../src/renderer/live/recog/recognize.ts');
const { groupStrokes } = await import('../../src/renderer/live/recog/geom.ts');
const { layoutLine } = await import('../../src/renderer/live/recog/layout.ts');
// @ts-expect-error plain JS test helper
const { strokesFor } = await import('../live/handwriting.mjs');
type Stroke = import('../../src/renderer/live/contract.ts').Stroke;
type LineRecognition = import('../../src/renderer/live/contract.ts').LineRecognition;

type W = { pts: number[][]; mark: string; glyph: number };
let n = 0;
const labels = new Map<string, { mark: string; glyph: number }>();
function write(text: string, o: Record<string, number> = {}): Stroke[] {
  return (strokesFor(text, { x: 60, y: 100, size: 24, jitter: 0.4, seed: 2, ...o }) as W[]).map((s) => {
    const id = `t${n++}`;
    labels.set(id, { mark: s.mark, glyph: s.glyph });
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of s.pts) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return { id, kind: 'pen', color: '#000', width: 1.5, pts: new Float32Array(s.pts.flat()), bbox: b } as Stroke;
  });
}

/**
 * A stand-in for InkAnalyzer: reads each group from the glyph labels, as one word, with
 * `confuse` turning the top reading into a typical misreading (the truth comes second).
 */
function fakeAnalyze(ids: string[], confuse: (s: string) => string = (s) => s) {
  return async (strokes: ArrayLike<number>[], opts: { groups: number[][] }) => {
    const lines = opts.groups.map((g, gi) => {
      const glyphs = new Map<number, { mark: string; x: number; ks: number[] }>();
      for (const k of g) {
        const l = labels.get(ids[k])!;
        if (l.mark === 'bar' || l.mark === 'radical') continue;
        const x = strokes[k][0];
        const cur = glyphs.get(l.glyph) ?? { mark: l.mark, x, ks: [] };
        cur.x = Math.min(cur.x, x);
        cur.ks.push(k);
        glyphs.set(l.glyph, cur);
      }
      // words: glyphs split at wide gaps (spaces)
      const sorted = [...glyphs.values()].sort((a, b) => a.x - b.x);
      const words: { mark: string; x: number; ks: number[] }[][] = [];
      sorted.forEach((v, i) => (i && v.x - sorted[i - 1].x > 17 ? words.push([v]) : (words.at(-1) ?? words[words.push([]) - 1]).push(v)));
      const out = words.map((ws) => {
        const truth = ws.map((v) => v.mark).join('');
        const top = confuse(truth);
        const ks = ws.flatMap((v) => v.ks);
        return { text: top, alternates: top === truth ? [truth] : [top, truth], strokes: ks, bbox: [ws[0].x, 0, ws.at(-1)!.x + 10, 0] as [number, number, number, number] };
      });
      return { group: gi, text: out.map((w) => w.text).join(' '), strokes: g, bbox: [0, 0, 0, 0] as [number, number, number, number], words: out };
    });
    return { engine: 'analyzer' as const, lines, drawings: [], ms: 1 };
  };
}

async function read(text: string, confuse?: (s: string) => string, o?: Record<string, number>) {
  const strokes = write(text, o);
  const ids = strokes.map((s) => s.id);
  const blocks = groupStrokes('p', strokes);
  assert.equal(blocks.length, 1, `one block for ${text}`);
  assert.equal(blocks[0].lines.length, 1, `one line for ${text}`);
  // the backend sends the line's strokes in line order; map indices back through the line
  const line = blocks[0].lines[0];
  const order = line.strokeIds.map((id) => strokes.find((s) => s.id === id)!);
  const rec = makeRecognizer([inkBackend(fakeAnalyze(order.map((s) => s.id), confuse))]);
  const res = await rec(blocks[0], new Map(strokes.map((s) => [s.id, s])));
  return { rec: res.lines[0], strokes };
}

test('2-D layout: fractions, exponents, roots and subscripts become linear text and LaTeX', async () => {
  const cases: [string, string, string][] = [
    ['2x+3=7', '2x+3=7', '2x+3=7'],
    ['x^2-4=(x-2)(x+2)', 'x^2-4=(x-2)(x+2)', 'x^{2}-4=(x-2)(x+2)'],
    [String.raw`\frac{3}{4}+\frac{1}{4}=1`, '(3)/(4)+(1)/(4)=1', String.raw`\frac{3}{4}+\frac{1}{4}=1`],
    [String.raw`\sqrt{x+1}=3`, 'sqrt(x+1)=3', String.raw`\sqrt{x+1}=3`],
    ['2^{10}=1024', '2^10=1024', '2^{10}=1024'],
    ['a_1+a_2=5', 'a_1+a_2=5', 'a_{1}+a_{2}=5'],
    ['3×4=12', '3*4=12', String.raw`3\times 4=12`],
    ['12÷4=3', '12/4=3', String.raw`12\div 4=3`],
    [String.raw`y=\frac{x^2+1}{2}`, 'y=(x^2+1)/(2)', String.raw`y=\frac{x^{2}+1}{2}`],
  ];
  for (const [write, text, latex] of cases) {
    const { rec } = await read(write);
    assert.equal(rec.kind, 'math', write);
    assert.equal(rec.text, text, write);
    assert.equal(rec.latex, latex, write);
    assert.ok(rec.confidence > 0.9, `${write}: confidence ${rec.confidence}`);
  }
});

test('glyph shape and context fix the classic confusables', async () => {
  const swap = (from: RegExp, to: string) => (s: string) => s.replace(from, to);
  // an upright cross read as x is a plus
  assert.equal((await read('(a+b)=c', swap(/\+/, 'x'))).rec.text, '(a+b)=c');
  // a stacked pair of bars is "=", a single bar a minus
  assert.equal((await read('7-2x=1', swap(/=/, '-'))).rec.text, '7-2x=1');
  // l / O / Z / S next to digits are 1 / 0 / 2 / 5
  assert.equal((await read('10x=50', (s) => s.replace('1', 'l').replace('0x', 'Ox'))).rec.text, '10x=50');
  assert.equal((await read('2x=6', swap(/^2/, 'Z'))).rec.text, '2x=6');
  assert.equal((await read('15+27=42', swap(/5/, 'S'))).rec.text, '15+27=42');
  // ÷ and × by shape
  assert.equal((await read('6÷3=2', swap(/÷/, '='))).rec.text, '6/3=2');
});

test('tokens map each character span back onto the strokes that drew it', async () => {
  const { rec, strokes } = await read('x^2-4=(x-2)(x+2)');
  const byId = new Map(strokes.map((s) => [s.id, labels.get(s.id)!.mark]));
  for (const t of rec.tokens) {
    const marks = [...new Set(t.strokeIds.map((id) => byId.get(id)))].join('');
    const piece = rec.text.slice(t.span[0], t.span[1]);
    assert.equal(marks, t.text.replace('^', ''), `token ${t.text}`);
    assert.equal(piece, t.text, `span of ${t.text}`);
  }
  // every written stroke is underlinable through some token
  const covered = new Set(rec.tokens.flatMap((t) => t.strokeIds));
  assert.equal(covered.size, strokes.length);
  const exp = rec.tokens.find((t) => t.text === '^2')!;
  assert.deepEqual(exp.span, [1, 3]);
});

test('a fraction bar and a root are tokens of their own', async () => {
  const { rec } = await read(String.raw`\frac{1}{2}+\sqrt{9}=3.5`);
  assert.equal(rec.text, '(1)/(2)+sqrt(9)=3.5');
  const bar = rec.tokens.find((t) => t.text === 'frac')!;
  assert.equal(rec.text.slice(...bar.span), '/');
  assert.equal(bar.strokeIds.length, 1);
  const root = rec.tokens.find((t) => t.text === '√')!;
  assert.equal(rec.text.slice(...root.span), 'sqrt');
});

test('prose lines are text with one token per word', async () => {
  const { rec } = await read('solve for x');
  assert.equal(rec.kind, 'text');
  assert.equal(rec.text, 'solve for x');
  assert.equal(rec.latex, String.raw`\text{solve for x}`);
});

test('k-best: alternates carry probabilities that sum with the confidence to at most 1', async () => {
  const { rec } = await read('2x+3=7', (s) => s.replace('7', '1'));
  assert.ok(rec.alternates.length >= 1);
  assert.equal(rec.alternateProbs?.length, rec.alternates.length);
  const total = rec.confidence + rec.alternateProbs!.reduce((a, b) => a + b, 0);
  assert.ok(total <= 1.0001, `total ${total}`);
});

test('fuse: agreement raises confidence, disagreement keeps the other reading as an alternate', () => {
  const base: LineRecognition = { lineId: 'l', kind: 'math', text: '2x=4', latex: '2x=4', confidence: 0.8, alternates: ['2x=9'], alternateProbs: [0.1], tokens: [], source: 'local-ink' };
  const agree = fuse([base, { ...base, confidence: 0.7, alternates: [], alternateProbs: [] }])!;
  assert.equal(agree.text, '2x=4');
  assert.ok(agree.confidence > 0.9);
  const disagree = fuse([base, { ...base, text: '2x=9', confidence: 0.85, alternates: [], alternateProbs: [] }])!;
  assert.ok(['2x=4', '2x=9'].includes(disagree.text));
  assert.ok(disagree.alternates.includes(disagree.text === '2x=4' ? '2x=9' : '2x=4'));
  const sum = disagree.confidence + disagree.alternateProbs!.reduce((a, b) => a + b, 0);
  assert.ok(sum <= 1.0001);
  assert.equal(fuse([null, base])!.text, '2x=4');
  assert.equal(fuse([null, null]), null);
});

test('recognition results are cached per line content', async () => {
  const strokes = write('3x=15');
  const blocks = groupStrokes('p', strokes);
  let calls = 0;
  const analyze = fakeAnalyze(blocks[0].lines[0].strokeIds);
  const rec = makeRecognizer([inkBackend(async (s, o) => (calls++, analyze(s, o)))]);
  const map = new Map(strokes.map((s) => [s.id, s]));
  const a = await rec(blocks[0], map);
  const b = await rec(blocks[0], map);
  assert.equal(calls, 1);
  assert.equal(a.lines[0].text, b.lines[0].text);
});

test('layout is fast enough to run on every settle', () => {
  const strokes = write(String.raw`y=\frac{x^2+1}{2x}-\sqrt{x+3}+a_1`);
  const t = performance.now();
  for (let i = 0; i < 50; i++) layoutLine(strokes);
  assert.ok((performance.now() - t) / 50 < 3);
});

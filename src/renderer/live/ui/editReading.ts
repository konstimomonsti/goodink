// "Edit reading" may fix what the recogniser misread, never what the learner wrote. An edit counts
// only when it is one of the recogniser's own other readings, or differs from what it read only in
// lookalike symbols (a/0, 1/l, 5/S, …). Otherwise typing the right answer would turn wrong ink green.

/** symbols handwriting recognisers confuse with each other */
const LOOKALIKE: string[][] = [
  ['a', '0', '9', '6', 'o', 'O', 'd'],
  ['l', '1', 'I', '|', '/', '7'],
  ['S', 's', '5'],
  ['z', 'Z', '2'],
  ['b', '6', 'h'],
  ['g', '9', 'q', 'y'],
  ['x', 'X', '×', '*', '·', 'k'],
  ['t', '+', 'f'],
  ['-', '−', '–', '='],
  ['u', 'v', 'n', 'r'],
  ['e', 'c'],
  ['(', '[', '{', 'C'],
  [')', ']', '}'],
];
const GROUP = new Map<string, number>();
LOOKALIKE.forEach((g, i) => g.forEach((c) => GROUP.set(c, i)));

const norm = (s: string) => s.replace(/\s+/g, '');
const alike = (a: string, b: string) => a === b || (GROUP.has(a) && GROUP.get(a) === GROUP.get(b));

/**
 * Readings without the recogniser's typical extras: an exponent or subscript made of a stray stroke
 * ("5^(-)" from the separate flag of a 5) and stray dots or commas. Removing those fixes a misread;
 * it never changes what was written in the line itself.
 */
function withoutExtras(read: string): string[] {
  const noScripts = read.replace(/\^\([^()]*\)|_\([^()]*\)|\^[-−.,']|_[-−.,']/g, '');
  const noPunct = (t: string) => t.replace(/(?<=\d)[.,'](?!\d)|^[.,']+|[.,']+$/g, '');
  return [...new Set([noScripts, noPunct(read), noPunct(noScripts)])].filter((t) => t !== read);
}

/** Is `edited` a plausible correction of a line read as `read` (with these alternative readings)? */
export function plausibleEdit(read: string, alternates: readonly string[], edited: string): boolean {
  const e = norm(edited);
  if (!e) return false;
  if ([read, ...alternates].some((r) => norm(r) === e)) return true;
  // dropping a misread exponent or a stray dot, possibly together with look-alike fixes
  if (withoutExtras(read).some((t) => norm(t) === e || plausibleEdit(t, [], edited))) return true;
  const r = [...norm(read)], w = [...e];
  // a dropped or doubled stroke: one symbol more or less, with the rest lining up. Only symbols that
  // carry no value: a digit, a sign or a relation more or less changes the maths (x=-3 -> x=3)
  if (Math.abs(r.length - w.length) === 1) {
    const [long, short] = r.length > w.length ? [r, w] : [w, r];
    for (let k = 0; k < long.length; k++) {
      if (!/^[.,'`()[\]{}^_|]$/.test(long[k])) continue;
      const cut = [...long.slice(0, k), ...long.slice(k + 1)];
      if (cut.every((c, i) => c === short[i])) return true;
    }
    return false;
  }
  if (r.length !== w.length) return false;
  let changed = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i] === w[i]) continue;
    if (!alike(r[i], w[i])) return false;
    changed++;
  }
  // a correction fixes a misread symbol or two, it does not rewrite the line
  return changed <= Math.max(2, Math.ceil(r.length / 4));
}

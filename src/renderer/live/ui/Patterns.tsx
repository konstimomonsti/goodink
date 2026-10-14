// "Your patterns": the mistake journal. Confirmed mistakes grouped by misconception (with the rule
// to remember when the engine knows it), newest example first, and one tap to turn them into
// flashcards in Study.
import { useMemo, useState } from 'react';
import { GraduationCap, Repeat2 } from 'lucide-react';
import { Button, Modal } from '../../ui/primitives';
import { MathHtml } from '../../ui/Math';
import { activateTab, showSection, toast } from '../../lib/store';
import type { JournalEntry, LiveUiEngine } from './engineApi';
import { plainToTex } from './latex';

const TAGS: Record<string, string> = {
  'sign-move': 'Moving a term across “=” without changing its sign',
  'distribute-first-term': 'Multiplying only the first term of a bracket',
  'square-of-sum': 'Squaring a sum term by term',
  'divide-one-side': 'Dividing only one side',
  arithmetic: 'Arithmetic slips',
};
export const tagLabel = (tag: string | undefined, title: string) => (tag && tag !== 'other' ? (TAGS[tag] ?? tag.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())) : title);

/** Journal of one notebook as the UI saw it, kept on this PC (the engine keeps its own too). */
const key = (nbId: string) => `goodink:live-journal:${nbId}`;
export function loadJournal(nbId: string): JournalEntry[] {
  try {
    return JSON.parse(localStorage.getItem(key(nbId)) ?? '[]') as JournalEntry[];
  } catch {
    return [];
  }
}
export function saveJournal(nbId: string, list: JournalEntry[]) {
  try {
    localStorage.setItem(key(nbId), JSON.stringify(list.slice(-300)));
  } catch {
    /* storage full or blocked: the journal is a convenience */
  }
}

type Group = { key: string; name: string; rule?: string; count: number; last: number; line?: string; fix?: string };

function groupsOf(entries: JournalEntry[]): Group[] {
  const m = new Map<string, JournalEntry[]>();
  for (const e of [...entries].sort((a, b) => b.at - a.at)) {
    const k = e.tag ?? e.title;
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return [...m.values()]
    .sort((a, b) => b.length - a.length || b[0].at - a[0].at)
    .map((g) => ({ key: g[0].tag ?? g[0].title, name: tagLabel(g[0].tag, g[0].title), count: g.length, last: g[0].at, line: g.find((e) => e.line)?.line, fix: g.find((e) => e.fix)?.fix }));
}

export function PatternsDialog({ entries, engine, onClose }: { entries: JournalEntry[]; engine?: LiveUiEngine | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const groups = useMemo((): Group[] => {
    const ps = engine?.patterns?.();
    if (!ps?.length) return groupsOf(entries);
    return ps.map((p) => {
      const e = entries.find((x) => (x.tag ?? 'other') === p.misconception && x.line);
      return { key: p.misconception, name: p.label, rule: p.rule, count: p.count, last: p.last, line: e?.line ?? p.examples[0], fix: e?.fix };
    });
  }, [entries, engine]);
  const cardable = entries.filter((e) => e.line);

  const makeCards = async () => {
    setBusy(true);
    try {
      const study = await import('../../study/model');
      await study.loadStudy();
      const decks = study.useStudy.getState().data.decks;
      const deck = decks.find((d) => d.name === 'My mistakes') ?? study.createDeck('My mistakes');
      const drafts =
        engine?.journalCards?.() ??
        cardable.map((e) => ({ front: `What is wrong in this step?\n$${plainToTex(e.line!)}$`, back: [`**${e.title}**`, e.detail ?? '', e.fix ? `Correct: $${e.fix}$` : ''].filter(Boolean).join('\n') }));
      let n = 0;
      for (const c of drafts) n += study.addBasic(deck.id, c.front, c.back, ['mistake']).length ? 1 : 0;
      toast(`${n} flashcard${n === 1 ? '' : 's'} added to “My mistakes”`, {
        kind: 'success',
        action: {
          label: 'Study',
          run: () => {
            activateTab(null);
            showSection('study');
          },
        },
      });
      onClose();
    } catch {
      toast('Could not make the flashcards.', { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Your patterns"
      size="md"
      onClose={onClose}
      className="live-patterns"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!groups.length || busy} onClick={() => void makeCards()}>
            <GraduationCap size={16} /> Make flashcards
          </Button>
        </>
      }
    >
      {groups.length === 0 ? (
        <div className="empty live-patterns-empty">
          <Repeat2 size={26} />
          <h2>No mistakes yet</h2>
          <p>Mistakes the live check confirms in this notebook collect here, grouped by the kind of slip, so you can see what keeps coming back.</p>
        </div>
      ) : (
        <ol className="live-pattern-list">
          {groups.map((g) => (
            <li key={g.key} className="live-pattern">
              <div className="live-pattern-head">
                <span className="live-pattern-name">{g.name}</span>
                <span className="live-pattern-count" aria-label={`${g.count} times`}>
                  ×{g.count}
                </span>
              </div>
              {g.rule && <p className="live-pattern-rule">{g.rule}</p>}
              {g.line && (
                <div className="live-pattern-ex">
                  <MathHtml tex={plainToTex(g.line)} display={false} />
                  {g.fix && (
                    <>
                      <span className="live-pattern-arrow" aria-label="should be">
                        →
                      </span>
                      <MathHtml tex={g.fix} display={false} />
                    </>
                  )}
                </div>
              )}
              <span className="live-pattern-when">Last {new Date(g.last).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

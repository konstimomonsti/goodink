// Streaming answers for the insight card and the AI selector.
//
// Transport note: provider traffic goes through the Rust command `ai_fetch`, which returns the whole
// response body at once. The SDKs still run in streaming mode (Anthropic SSE, OpenAI `stream: true`),
// so deltas arrive in one burst when the body lands; the Pacer below reveals them progressively and
// smoothly. Once the backend streams chunks (see docs: an `ai_fetch_stream` command that sends body
// chunks over a tauri::ipc::Channel), the same code streams for real with no change here.
import { complete, type AiChoice, type CompleteImage, type Turn, type Usage } from '../../lib/ai';
import { POLICY, questionFor, splitFollowUps, TUTOR_SYSTEM, type HintLevel, type IssueBrief, type QuickActionId } from './policy';

/**
 * Reveals text at a steady pace: each tick shows a share of what is waiting, so a burst drains in
 * about a third of a second and a trickle shows as it comes.
 */
export class Pacer {
  private full = '';
  private shown = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;
  private done: (() => void) | null = null;
  private emit: (textSoFar: string) => void;
  private tick: number;
  constructor(emit: (textSoFar: string) => void, tick = 16) {
    this.emit = emit;
    this.tick = tick;
  }

  get received() {
    return this.full.length;
  }

  push(delta: string) {
    this.full += delta;
    this.schedule();
  }

  private schedule() {
    if (this.timer || this.shown >= this.full.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const backlog = this.full.length - this.shown;
      this.shown += Math.min(backlog, Math.max(3, Math.ceil(backlog / 8)));
      this.emit(this.full.slice(0, this.shown));
      if (this.shown < this.full.length) this.schedule();
      else if (this.ended) this.done?.();
    }, this.tick);
  }

  /** resolves once everything pushed has been shown */
  end(): Promise<void> {
    this.ended = true;
    if (this.shown >= this.full.length) return Promise.resolve();
    return new Promise((r) => {
      this.done = r;
      this.schedule();
    });
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.done?.();
  }
}

export interface StreamAskOpts {
  choice: AiChoice;
  images: CompleteImage[];
  /** what the engine knows: the recognised lines, the verdict, the issue */
  context?: string;
  question?: string;
  history?: Turn[];
  signal?: AbortSignal;
  level?: HintLevel;
  action?: QuickActionId;
  issue?: IssueBrief;
  /** the CAS's correct step or solution, when it has one */
  grounding?: string;
  maxTokens?: number;
}

export interface StreamAskResult {
  text: string;
  followUps: string[];
  usage: Usage | null;
  truncated: boolean;
  model: string;
}

/** The first user turn: context + the question for the ladder level / quick action. */
export function askTurns(o: Pick<StreamAskOpts, 'context' | 'question' | 'history' | 'level' | 'action' | 'issue' | 'grounding'>): Turn[] {
  const q = questionFor({ question: o.question, level: o.level, action: o.action, issue: o.issue, grounding: o.grounding });
  const history = o.history ?? [];
  const first = [o.context?.trim() ? `Context (local reading of the handwriting, may contain misreads):\n${o.context.trim()}` : '', history.length ? history[0].text : q].filter(Boolean).join('\n\n');
  return history.length ? [{ role: 'user', text: first }, ...history.slice(1), { role: 'user', text: q }] : [{ role: 'user', text: first }];
}

/** Ask with streaming; onDelta gets the visible text so far (follow-up line hidden). */
export async function streamAsk(o: StreamAskOpts, onDelta: (textSoFar: string) => void, run: typeof complete = complete): Promise<StreamAskResult> {
  const pacer = new Pacer((t) => onDelta(splitFollowUps(t).body));
  const abort = () => pacer.cancel();
  o.signal?.addEventListener('abort', abort, { once: true });
  try {
    const r = await run(o.choice, {
      system: TUTOR_SYSTEM,
      images: o.images,
      turns: askTurns(o),
      maxTokens: o.maxTokens ?? POLICY.budget.answer,
      signal: o.signal,
      onDelta: (d) => pacer.push(d),
    });
    // a provider that ignored streaming still delivers the whole text: reveal it the same way
    if (!pacer.received && r.text) pacer.push(r.text);
    await pacer.end();
    const { body, followUps } = splitFollowUps(r.text);
    onDelta(body);
    return { text: body.trim(), followUps, usage: r.usage, truncated: r.truncated, model: r.model };
  } finally {
    o.signal?.removeEventListener('abort', abort);
  }
}

// Mock AI provider for Live Ink, plus an end-to-end scenario.
//
//   import { startMockAi } from './live/mock-ai.mjs';
//   const mock = await startMockAi({ truth: { '2x=10': 'error' } });
//   ... point the app at mock.openaiBase (provider 'ollama' or 'custom') or mock.anthropicBase
//   mock.set({ latency: 1500 }); mock.set({ fail: { status: 429, times: 2 } }); mock.calls; mock.close()
//
// One server speaks the OpenAI-compatible API (/v1/models, /v1/chat/completions, streaming with
// include_usage) and the Anthropic Messages API (/anthropic/v1/messages, SSE). It recognises the
// request kind from the system prompt: block check, independent verification, tutor answer,
// transcription; verdicts come from `truth` (reading -> 'ok' | 'error'), usage is realistic
// (image tokens from the PNG size, text tokens from the length).
//
// Scenario (keyless 'ollama' provider pointed at the mock, so no key is ever stored):
//   node tests/drive-tauri.mjs tests/live/mock-ai.mjs src-tauri/target/debug/goodink.exe
import http from 'node:http';

const DEFAULT_TRUTH = { '2x+3=7': 'ok', '2x=4': 'ok', 'x=2': 'ok', '2x=10': 'error', 'x=5': 'error' };
const EXPLAIN = {
  '2x=10': { wrongSpan: '10', title: 'Subtraction error', detail: 'Subtracting $3$ from both sides of $2x+3=7$ gives $2x=4$, not $2x=10$.', hint: 'What is $7-3$?', fix: '2x=4' },
  'x=5': { wrongSpan: '5', title: 'Follows the earlier slip', detail: 'With $2x=4$, dividing by $2$ gives a different value.', hint: 'Divide both sides by $2$.', fix: 'x=2' },
};

const pngSize = (b64) => {
  try {
    const b = Buffer.from(b64.slice(0, 40), 'base64');
    return b.toString('ascii', 1, 4) === 'PNG' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  } catch {
    return null;
  }
};
const imageTokens = (w, h) => 85 + 170 * Math.ceil(w / 512) * Math.ceil(h / 512);
const textTokens = (s) => Math.ceil(s.length / 3.6);

export async function startMockAi(opts = {}) {
  const cfg = { truth: { ...DEFAULT_TRUTH, ...(opts.truth ?? {}) }, readings: opts.readings ?? null, latency: opts.latency ?? 0, fail: null, verifyValid: null, tutor: opts.tutor ?? null };
  const calls = [];

  function kindOf(system) {
    if (/check one step of a student's handwritten math/i.test(system)) return 'check';
    if (/verify one step/i.test(system)) return 'verify';
    if (/transcribe speech/i.test(system)) return 'transcribe';
    if (/tutor/i.test(system)) return 'tutor';
    return 'other';
  }

  function reply(kind, userText) {
    if (kind === 'check') {
      // the judge gets the local reading as text; the mock cannot see the image, so `readings`
      // (when set) stands in for what the image shows and corrects the local reading
      const local = (/text: (.*)/.exec(userText)?.[1] ?? '').replace(/\s+/g, '');
      const shown = cfg.readings?.length ? cfg.readings.shift() : local;
      if (cfg.readings && !cfg.readings.length) cfg.readings = null;
      const v = cfg.truth[shown] ?? cfg.truth[local] ?? 'unsure';
      const ex = v === 'error' ? EXPLAIN[shown] ?? { wrongSpan: '', title: 'Check this step', detail: 'This does not follow.', hint: '', fix: '' } : { wrongSpan: '', title: '', detail: '', hint: '', fix: '' };
      const corrected = shown && shown !== local ? shown : '';
      return JSON.stringify({ reading_ok: !corrected, corrected, latex: shown, verdict: v, wrong_span: ex.wrongSpan, title: ex.title, detail: ex.detail, hint: ex.hint, fix: ex.fix, misconception: v === 'error' ? 'sign-move' : '', concept: 'Linear equations' });
    }
    if (kind === 'verify') {
      const step = /Step to verify:\n(.*)/.exec(userText)?.[1]?.trim() ?? '';
      const valid = cfg.verifyValid ?? (cfg.truth[step] === 'error' ? 'no' : cfg.truth[step] === 'ok' ? 'yes' : 'unsure');
      return JSON.stringify({ readingOk: true, work: '2x+3=7 -> 2x=4 -> x=2', valid, reason: valid === 'no' ? 'The arithmetic is off.' : 'Fine.' });
    }
    if (kind === 'transcribe') return 'why do I subtract three first';
    if (kind === 'tutor')
      return cfg.tutor ?? 'Look at how you went from $2x+3=7$ to the next line: what happens to the $+3$ when you take it to the other side? Work out $7-3$ again.\n>>> Why subtract first? | Show a similar example';
    return 'ok';
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const t0 = Date.now();
      const json = body ? JSON.parse(body) : null;
      const send = (status, obj, headers = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
      if (req.method === 'GET' && /\/models/.test(req.url)) {
        if (req.url.startsWith('/anthropic')) return send(200, { data: [{ id: 'claude-haiku-5-5', type: 'model', display_name: 'Haiku', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-haiku-5-5', last_id: 'claude-haiku-5-5' });
        return send(200, { object: 'list', data: ['mock-vision', 'mock-vision-lite'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })) });
      }
      const anthropic = req.url.startsWith('/anthropic/v1/messages');
      const openai = /\/chat\/completions$/.test(req.url);
      if (!anthropic && !openai) return res.writeHead(404).end('{}');

      const system = anthropic ? (typeof json.system === 'string' ? json.system : (json.system ?? []).map((b) => b.text).join('')) : json.messages.find((m) => m.role === 'system')?.content ?? '';
      const first = anthropic ? json.messages[0] : json.messages.find((m) => m.role === 'user');
      const parts = Array.isArray(first.content) ? first.content : [{ type: 'text', text: first.content }];
      const lastUser = [...json.messages].reverse().find((m) => m.role === 'user');
      const userText = (Array.isArray(lastUser.content) ? lastUser.content : [{ type: 'text', text: lastUser.content }]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const firstText = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const images = parts
        .map((p) => (p.type === 'image_url' ? p.image_url.url.split(',')[1] : p.type === 'image' ? p.source.data : null))
        .filter(Boolean)
        .map((d) => ({ bytes: Math.round((d.length * 3) / 4), ...(pngSize(d) ?? { w: 0, h: 0 }) }));
      const kind = kindOf(system);
      const call = { kind, at: t0, path: req.url, model: json.model, stream: !!json.stream, json: !!(json.response_format || json.output_config?.format), maxTokens: json.max_tokens ?? json.max_completion_tokens, effort: json.reasoning_effort ?? json.output_config?.effort ?? null, images, user: firstText, system, status: 200, usage: null, ms: 0 };
      calls.push(call);

      if (cfg.fail && cfg.fail.times > 0) {
        cfg.fail.times--;
        call.status = cfg.fail.status;
        return send(cfg.fail.status, { error: { message: 'mock failure', type: 'rate_limit_error' } }, cfg.fail.status === 429 ? { 'retry-after': '1' } : {});
      }
      if (cfg.latency) await new Promise((r) => setTimeout(r, cfg.latency));

      const text = reply(kind, kind === 'verify' || kind === 'check' ? firstText : userText);
      const usage = { input: textTokens(system) + json.messages.reduce((n, m) => n + textTokens(typeof m.content === 'string' ? m.content : m.content.filter((p) => p.type === 'text').map((p) => p.text).join('')), 0) + images.reduce((n, i) => n + imageTokens(i.w || 512, i.h || 512), 0), output: textTokens(text) };
      call.usage = usage;
      call.ms = Date.now() - t0;

      if (anthropic) {
        const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(ev('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 0 } } }));
        res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
        for (let i = 0; i < text.length; i += 24) res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 24) } }));
        res.write(ev('content_block_stop', { index: 0 }));
        res.write(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } }));
        return res.end(ev('message_stop', {}));
      }
      if (json.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta, finish = null, u) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: json.model, choices: delta == null ? [] : [{ index: 0, delta, finish_reason: finish }], ...(u ? { usage: u } : {}) })}\n\n`;
        res.write(chunk({ role: 'assistant', content: '' }));
        for (let i = 0; i < text.length; i += 16) {
          res.write(chunk({ content: text.slice(i, i + 16) }));
          if (cfg.chunkDelay) await new Promise((r) => setTimeout(r, cfg.chunkDelay));
        }
        res.write(chunk({}, 'stop'));
        res.write(chunk(null, null, { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output }));
        return res.end('data: [DONE]\n\n');
      }
      return send(200, { id: 'c', object: 'chat.completion', created: 0, model: json.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
    });
  });
  await new Promise((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    openaiBase: `http://127.0.0.1:${port}/v1`,
    anthropicBase: `http://127.0.0.1:${port}/anthropic`,
    calls,
    set: (o) => Object.assign(cfg, o),
    reset: () => (calls.length = 0),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---- end-to-end scenario --------------------------------------------------------------------------

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};

export default async ({ win, shot }) => {
  const { newNotebook, writeText, pageOrigin } = await import('./handwriting.mjs');
  const mock = await startMockAi();
  const results = {};
  const ok = (name, cond, info = '') => {
    results[name] = !!cond;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  };
  try {
    await win.setViewportSize({ width: 1280, height: 860 }).catch(() => {});
    await newNotebook(win, 'Live tutor');
    // the keyless local provider pointed at the mock: no API key is stored anywhere
    await win.evaluate((base) => {
      const g = window.__goodink;
      const st = g.useApp.getState().settings;
      g.updateSettings({ live: { ...(st.live ?? {}), mode: 'off' }, ai: { provider: 'ollama', models: { ollama: 'mock-vision' }, efforts: {}, baseURLs: { ollama: base }, keys: ['ollama'] } });
    }, mock.openaiBase);
    const { pageId } = await pageOrigin(win);

    // our own engine instance on the open session (the UI's own one is switched off above)
    await win.evaluate(async (pid) => {
      const m = await import('/live/engine.ts');
      const g = window.__goodink;
      const s = await g.getSession(g.useApp.getState().active);
      const e = new m.LiveEngine(s, { mode: 'smart' });
      const log = [];
      e.subscribe((ev) => {
        if (ev.type !== 'decorations' || ev.pageId !== pid) return;
        log.push({ t: performance.now(), kinds: e.decorations(pid).map((d) => `${d.kind}|${d.title ?? ''}`) });
      });
      e.decorations(pid);
      m.__cas = (await import('/live/math/index.ts')).math;
      window.__lt = { e, m, s, log, pid };
    }, pageId);

    const markTime = () => win.evaluate(() => performance.now());
    const count = (k) => win.evaluate((kk) => window.__lt.e.decorations(window.__lt.pid).filter((d) => d.kind === kk).length, k);
    // ms from `after` until the page shows more marks of this kind than it had then
    const waitKind = async (kind, after, timeout = 15000) => {
      // kind: 'error', or 'unsure|<title>' for amber marks that came from the AI
      const had = await win.evaluate(([k, t]) => {
        const prev = window.__lt.log.filter((x) => x.t <= t).pop();
        return prev ? prev.kinds.filter((x) => x.startsWith(k)).length : 0;
      }, [kind, after]);
      return win.waitForFunction(([k, t, n]) => window.__lt.log.some((x) => x.t > t && x.kinds.filter((y) => y.startsWith(k)).length > n), [kind, after, had], { timeout, polling: 30 }).then(
        () => win.evaluate(([k, t, n]) => window.__lt.log.find((x) => x.t > t && x.kinds.filter((y) => y.startsWith(k)).length > n).t - t, [kind, after, had]),
        () => null,
      );
    };

    // 1. a correct line and a wrong step
    await writeText(win, '2x+3=7', { x: 80, y: 140, size: 30, seed: 3 });
    await writeText(win, '2x=10', { x: 80, y: 200, size: 30, seed: 4 });
    const t1 = await markTime();
    const redMs = await waitKind('error', t1);
    ok('wrong step turns red after independent confirmation', redMs != null, `${redMs?.toFixed(0)} ms after the last pen-up (incl. 600 ms settle)`);
    const checks = mock.calls.filter((c) => c.kind === 'check');
    const verifies = mock.calls.filter((c) => c.kind === 'verify');
    const info = await win.evaluate(() => {
      const { e, pid } = window.__lt;
      const b = e.blockFor(pid, [0, 100, 400, 260]);
      const c = b && e.check(b.id);
      return c && { via: c.via, lines: c.recognition.lines.map((l) => `${l.text} (${l.confidence.toFixed(2)}; ${l.tokens.map((t) => `${t.text}@${t.span}:${t.bbox.map(Math.round)}`).join(" ")})`), verdicts: c.lines.map((l) => l.verdict), issues: c.issues.map((i) => `${i.severity}/${i.source} span ${JSON.stringify(i.span)}: ${i.title}`) };
    });
    console.log('block check:', JSON.stringify(info));
    // confirmation: either the blind second call, or the local CAS agreeing (then no second call)
    const casConfirmed = info?.issues.some((i) => /error\/(local-cas|ai-verified)/.test(i)) && verifies.length === 0;
    // the CAS proved it on a confident reading: Smart sends nothing at all
    const casOnly = info?.via === 'local' && info.issues.some((i) => i.startsWith('error/local-cas'));
    ok('AI used only when needed; AI errors confirmed by a blind call or the CAS', casOnly ? checks.length === 0 : checks.length === 1 && (verifies.length === 1 || casConfirmed), casOnly ? 'CAS decided locally, 0 AI calls' : `${checks.length} check, ${verifies.length} verify`);
    ok('verifier never sees the first verdict', verifies.every((v) => !/Subtraction error|error/i.test(v.user)));
    const c0 = checks[0];
    if (c0) {
      ok('structured JSON output requested', c0.json);
      ok('small crop image', c0.images.length === 1 && c0.images[0].w <= 1000 && c0.images[0].h <= 1000, `${c0.images[0]?.w}x${c0.images[0]?.h} px, ${c0.images[0]?.bytes} bytes`);
      ok('small output budget', c0.maxTokens <= 800, `max_tokens ${c0.maxTokens}`);
      console.log(`tokens per Smart check: check ${c0.usage?.input} in / ${c0.usage?.output} out; verify ${verifies[0]?.usage?.input} in / ${verifies[0]?.usage?.output} out`);
    }
    const st1 = await win.evaluate(() => window.__lt.e.stats());
    console.log('engine stats:', JSON.stringify(st1));
    const decos = await win.evaluate(() => window.__lt.e.decorations(window.__lt.pid));
    console.log('decorations:', JSON.stringify(decos.map((d) => ({ kind: d.kind, title: d.title, underline: d.underline }))));
    await shot('tutor-01-red');

    // 2. unchanged content is never re-sent: touch the page without changing the block
    const before = mock.calls.length;
    await win.evaluate(() => {
      const { s, pid } = window.__lt;
      const c = s.content(pid);
      s.commit(pid, { ...c, strokes: [...c.strokes] }, { record: false });
    });
    await win.waitForTimeout(1200);
    ok('unchanged block is not re-checked', mock.calls.length === before, `${mock.calls.length - before} new calls`);

    // 3. erasing a stroke clears that line's marks at once
    const tErase = await markTime();
    await win.evaluate(() => {
      const { s, pid } = window.__lt;
      const c = s.content(pid);
      s.commit(pid, { ...c, strokes: c.strokes.slice(0, -1) });
    });
    const cleared = await win.waitForFunction((t) => window.__lt.log.some((x) => x.t > t && !x.kinds.some((k) => k.startsWith('error'))), tErase, { timeout: 2000, polling: 16 }).then(
      () => win.evaluate((t) => window.__lt.log.find((x) => x.t > t && !x.kinds.some((k) => k.startsWith('error'))).t - t, tErase),
      () => null,
    );
    ok('marks clear immediately on edit', cleared != null && cleared < 100, `${cleared?.toFixed(1)} ms`);
    // undo brings the same content back: marks return from the cache without any call
    const beforeUndo = mock.calls.filter((c) => c.kind === 'check').length;
    await win.evaluate(() => window.__lt.s.undo());
    await win.waitForTimeout(1500);
    // (the erased state was new content and got its own check while we waited)
    const undoKinds = await win.evaluate(() => window.__lt.e.decorations(window.__lt.pid).map((d) => d.kind));
    ok('undo restores the red mark from the cache', undoKinds.includes('error'), `${mock.calls.filter((c) => c.kind === 'check').length - beforeUndo} check calls for the erased state`);

    // 4. the AI path itself: an engine whose CAS decides nothing (as for maths beyond its reach),
    //    so every line goes to the judge; 800 ms injected per provider call
    await win.evaluate(() => {
      const L = window.__lt;
      L.e.dispose();
      const undecided = { ...L.m.__cas, checkSteps: (lines) => ({ lines: lines.map((l) => ({ lineId: l.lineId, verdict: 'unsure' })), issues: [] }) };
      L.e = new L.m.LiveEngine(L.s, { mode: 'smart', math: undecided });
      L.e.subscribe((ev) => ev.type === 'decorations' && ev.pageId === L.pid && L.log.push({ t: performance.now(), kinds: L.e.decorations(L.pid).map((d) => `${d.kind}|${d.title ?? ''}`) }));
      L.e.decorations(L.pid);
    });
    await win.waitForTimeout(800);
    mock.reset();
    mock.set({ latency: 800 });
    const lat = [], amb = [];
    for (let i = 0; i < 3; i++) {
      const line = i % 2 ? 'x=5' : '2x=10';
      // what the image shows (the mock cannot see it): the judge corrects a local misread to this
      mock.set({ readings: [line] });
      await writeText(win, line, { x: 80, y: 300 + i * 90, size: 30, seed: 10 + i });
      const t0 = await markTime();
      const [amber, ms] = await Promise.all([waitKind(`unsure|${i % 2 ? 'Follows' : 'Subtraction'}`, t0, 20000), waitKind('error', t0, 20000)]);
      if (ms != null) lat.push(ms);
      if (amber != null) amb.push(amber);
    }
    console.log('AI-path checks:', JSON.stringify(await win.evaluate(() => { const { e, pid } = window.__lt; return [0, 1, 2].map((i) => { const b = e.blockFor(pid, [0, 290 + i * 90, 400, 330 + i * 90]); const c = b && e.check(b.id); return c && { via: c.via, lines: c.recognition.lines.map((l) => l.text), v: c.lines, issues: c.issues.map((x) => x.severity + '/' + x.source + ':' + x.title) }; }); })));
    const vs = mock.calls.filter((c) => c.kind === 'verify'), js = mock.calls.filter((c) => c.kind === 'check');
    // the re-solve starts with the judge, not after it
    const parallel = js.every((j) => vs.some((v) => Math.abs(v.at - j.at) < 300));
    ok('wrong lines go to the judge and are confirmed by a parallel blind re-solve', lat.length === 3 && parallel, `${js.length} judge, ${vs.length} verify calls, parallel: ${parallel}`);
    console.log(`with 800 ms per provider call: first amber mark ${amb.map((x) => x.toFixed(0)).join(', ')} ms, confirmed red ${lat.map((x) => x.toFixed(0)).join(', ')} ms after pen-up (p50 red ${pct(lat, 50)?.toFixed?.(0)})`);
    mock.set({ latency: 0 });

    // 5. a rate-limited provider: the local verdict stands, the pill says so, nothing turns red
    mock.set({ fail: { status: 429, times: 99 } });
    const red5 = await count('error');
    await writeText(win, '2x=10', { x: 80, y: 640, size: 30, seed: 21 });
    await win.waitForTimeout(2500);
    const st5 = await win.evaluate(() => window.__lt.e.stats());
    const red5b = await count('error');
    ok('429: local verdict stands, AI shown as paused, nothing new turns red', st5.state === 'offline' && red5b === red5, `state ${st5.state}, red ${red5} -> ${red5b}`);
    mock.set({ fail: null });
    await win.evaluate(() => window.__lt.e.ai.breaker.reset());

    // 6. streaming hint through the UI interface
    const hint = await win.evaluate(async () => {
      const { m, s, pid } = window.__lt;
      const ui = m.createUiEngine(s);
      ui.setMode('smart');
      const e = window.__lt.e;
      const blk = e.blockFor(pid, [0, 120, 300, 230]);
      const ins = blk && e.insightFor(pid, blk, 205);
      if (!ins) return { error: 'no block' };
      const updates = [];
      const t0 = performance.now();
      const text = await ui.hint(ins, 1, { onDelta: (t) => updates.push([performance.now() - t0, t.length]) });
      ui.dispose();
      return { text, updates: updates.length, firstMs: updates[0]?.[0], lastMs: updates[updates.length - 1]?.[0] };
    });
    ok('hint streams progressively', hint.updates > 3 && !/>>>/.test(hint.text ?? ''), `${hint.updates} updates, first ${hint.firstMs?.toFixed(0)} ms, done ${hint.lastMs?.toFixed(0)} ms`);
    console.log('hint:', hint.text);

    // 7. Local mode sends nothing
    mock.reset();
    await win.evaluate(() => window.__lt.e.setMode('local'));
    await writeText(win, 'x=5', { x: 80, y: 740, size: 30, seed: 31 });
    await win.waitForTimeout(1500);
    ok('Local mode makes zero AI calls', mock.calls.length === 0, `${mock.calls.length} calls`);

    // the real UI on top, for a look
    await win.evaluate(() => window.__lt.e.dispose());
    await win.evaluate(() => {
      const g = window.__goodink;
      g.updateSettings({ live: { ...(g.useApp.getState().settings.live ?? {}), mode: 'smart' } });
    });
    await win.waitForTimeout(3000);
    await shot('tutor-02-ui');
    const failed = Object.entries(results).filter(([, v]) => !v).map(([k]) => k);
    console.log(failed.length ? `FAILED: ${failed.join('; ')}` : 'ALL PASSED');
  } finally {
    await mock.close();
  }
};

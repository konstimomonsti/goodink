// A small LRU cache keyed by content hash. The AI results cache is persisted (debounced) so that
// reopening a notebook never pays for the same block twice. Storage is the web view's
// localStorage: tiny (a few hundred entries of short JSON), private to this app's profile.
export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export class Lru<V> {
  private m = new Map<string, V>();
  private max: number;
  constructor(max = 200) {
    this.max = max;
  }

  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }

  has(k: string) {
    return this.m.has(k);
  }

  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }

  delete(k: string) {
    this.m.delete(k);
  }

  get size() {
    return this.m.size;
  }

  entries(): [string, V][] {
    return [...this.m.entries()];
  }
}

/** The browser's localStorage when there is one (not in unit tests). */
export function browserKV(): KV | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) };
  } catch {
    return null;
  }
}

/** An LRU that loads from and saves to a KV store under one key. */
export class PersistentLru<V> extends Lru<V> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private kv: KV | null;
  private key: string;
  private maxBytes: number;
  constructor(kv: KV | null, key: string, max = 200, maxBytes = 400_000) {
    super(max);
    this.kv = kv;
    this.key = key;
    this.maxBytes = maxBytes;
    if (!kv) return;
    try {
      const raw = kv.get(key);
      if (raw) for (const [k, v] of JSON.parse(raw) as [string, V][]) super.set(k, v);
    } catch {
      /* a damaged cache is simply empty */
    }
  }

  override set(k: string, v: V) {
    super.set(k, v);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.kv || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.save();
    }, 1500);
  }

  save() {
    if (!this.kv) return;
    let list = this.entries();
    let json = JSON.stringify(list);
    // keep the newest entries that fit
    while (json.length > this.maxBytes && list.length > 1) {
      list = list.slice(Math.ceil(list.length / 4));
      json = JSON.stringify(list);
    }
    try {
      this.kv.set(this.key, json);
    } catch {
      /* storage full: stay in memory */
    }
  }
}

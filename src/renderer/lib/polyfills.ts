// What WebKit (Linux's WebKitGTK, Safari's engine) lacks and goodink uses, filled in before anything
// else runs. WebView2 (Windows) and Android's WebView have all of it, so this does nothing there.

type IdleDeadline = { didTimeout: boolean; timeRemaining(): number };
const w = window as unknown as {
  requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

if (typeof w.requestIdleCallback !== 'function') {
  // run soon after the current frame, with a 50 ms budget like the real thing
  w.requestIdleCallback = (cb, opts) => {
    const start = performance.now();
    return window.setTimeout(() => cb({ didTimeout: !!opts?.timeout && performance.now() - start >= opts.timeout, timeRemaining: () => Math.max(0, 50 - (performance.now() - start)) }), 1);
  };
  w.cancelIdleCallback = (id) => window.clearTimeout(id);
}

export {};

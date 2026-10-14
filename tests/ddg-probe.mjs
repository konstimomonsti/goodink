// What DuckDuckGo answers through the backend.
export default async ({ win }) => {
  await win.waitForTimeout(1200);
  for (const variant of [
    { method: 'POST', url: 'https://html.duckduckgo.com/html/', body: 'q=SN1+SN2+reaction', headers: [['content-type', 'application/x-www-form-urlencoded']] },
    { method: 'GET', url: 'https://html.duckduckgo.com/html/?q=SN1+SN2+reaction', body: null, headers: [] },
    { method: 'GET', url: 'https://lite.duckduckgo.com/lite/?q=SN1+SN2+reaction', body: null, headers: [] },
  ]) {
    const r = await win.evaluate((v) =>
      window.__TAURI_INTERNALS__.invoke('ai_fetch', { req: { url: v.url, method: v.method, headers: [['user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'], ['accept', 'text/html'], ['accept-language', 'en-US,en;q=0.9'], ...v.headers], body: v.body, secret: null } }), variant);
    console.log(variant.method, variant.url.slice(8, 40), '→', r.status, r.body.length, 'bytes | results:', (r.body.match(/result__a|result-link/g) ?? []).length, '| anomaly:', /anomaly|captcha|challenge/i.test(r.body), '|', r.body.replace(/\s+/g, ' ').slice(0, 140));
  }
};

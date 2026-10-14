// Which Gemini model ids exist for this key (one models.list request).
export default async ({ win }) => {
  await win.waitForTimeout(1200);
  const r = await win.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke('ai_fetch', { req: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', method: 'GET', headers: [['authorization', 'Bearer __GOODINK_SECRET__']], body: null, secret: 'google' } }),
  );
  const ids = (JSON.parse(r.body).data ?? []).map((m) => m.id.replace(/^models\//, ''));
  console.log('status', r.status, '| flash ids:', ids.filter((i) => /flash/.test(i) && !/image|tts|live|audio|embed/.test(i)).join(', '));
};

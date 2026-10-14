// Anki's Add window in goodink: node tests/drive-tauri.mjs tests/addnote.mjs
// Migration of 2.x cards, note types, formatting, cloze, sticky fields, tags, duplicates, Fields…,
// Cards…, preview, history, type-in-the-answer review, Browse editing, and the Decks-first Study.

export default async ({ win, shot }) => {
  const invoke = (cmd, args) => win.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
  const study = () => win.evaluate(() => JSON.parse(JSON.stringify(window.__goodink_study?.() ?? null)));
  const disk = async () => { await win.waitForTimeout(900); return JSON.parse(await invoke('doc_read', { name: 'study.json' })); };
  const field = (i) => win.locator('.ne-rich').nth(i);
  const ok = (label, v) => console.log(`${v ? 'OK  ' : 'FAIL'} ${label}`);
  void study;

  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  // a collection from goodink 2.9: text on the cards
  const now = Date.now();
  const card = (id, noteId, type, ord, front, back, tags = []) => ({ id, noteId, deckId: 'd1', type, ord, front, back, tags, created: now, modified: now, ease: 2.5, interval: 0, due: 0, state: 'new' });
  await invoke('doc_write', {
    name: 'study.json',
    json: JSON.stringify({
      v: 1,
      decks: [{ id: 'd1', name: 'Vorkurs ET', created: now, options: {} }],
      cards: [card('c1', 'n1', 'basic', 0, 'Ohm <law>', 'U = R·I', ['et']), card('c2', 'n2', 'reversed', 0, 'Spannung', 'voltage'), card('c3', 'n2', 'reversed', 1, 'Spannung', 'voltage'), card('c4', 'n3', 'cloze', 1, '{{c1::Strom}} fließt', 'extra')],
      resources: [], revlog: [], imported: [],
    }),
  });

  await win.locator('.lib-tab', { hasText: 'Study' }).click();
  await win.locator('.st-decks').waitFor();
  ok('Study opens on the decks', (await win.locator('.st-tab.is-active').innerText()) === 'Decks');
  const migrated = await disk().catch(() => null);
  ok(`migration: v${migrated?.v}, ${migrated?.notes?.length} notes, ${migrated?.cards?.length} cards, types ${migrated?.noteTypes?.length}`, migrated?.v === 2 && migrated.notes.length === 3 && migrated.cards.length === 4 && !('front' in migrated.cards[0]));
  ok('migrated text is escaped HTML', migrated?.notes[0].fields[0] === 'Ohm &lt;law&gt;');

  // the Add window
  await win.locator('.st-tab', { hasText: 'Add' }).click();
  await win.locator('.add-win').waitFor();
  ok(`type/deck: ${await win.locator('.add-chooser').nth(0).innerText()} / ${await win.locator('.add-chooser').nth(1).innerText()}`, (await win.locator('.add-chooser').nth(0).innerText()) === 'Basic');
  ok('first field focused', await field(0).evaluate((el) => document.activeElement === el));
  await shot('add-01-empty');

  // formatting with shortcuts and the toolbar
  await win.keyboard.press('Control+b');
  await win.keyboard.type('H');
  await win.keyboard.press('Control+b');
  await win.keyboard.type('2');
  await win.keyboard.press('Shift+ArrowLeft');
  await win.keyboard.press('Control+=');
  await win.keyboard.press('End');
  await win.keyboard.press('Control+=');
  await win.keyboard.type('O is?');
  await field(1).click();
  await win.keyboard.type('water');
  await win.keyboard.press('Shift+Home');
  await win.getByRole('button', { name: 'Italic' }).click();
  await win.getByRole('button', { name: 'Text colour', exact: true }).click();
  ok(`front HTML: ${await field(0).innerHTML()}`, /<b>H<\/b><sub>2<\/sub>O is\?/.test(await field(0).innerHTML()));
  ok(`back HTML: ${await field(1).innerHTML()}`, /<i[ >]/.test(await field(1).innerHTML()) && /color/.test(await field(1).innerHTML()));
  // tags with autocomplete from existing ones
  await win.keyboard.press('Control+Shift+T');
  await win.keyboard.type('e');
  ok(`tag suggestions: ${(await win.locator('.ne-suggest li').allInnerTexts()).join(',')}`, (await win.locator('.ne-suggest li').count()) >= 1);
  await win.keyboard.press('Enter');
  await win.keyboard.type('chemie ');
  ok(`tags: ${(await win.locator('.ne-tag').allInnerTexts()).join(',')}`, (await win.locator('.ne-tag').count()) === 2);
  await shot('add-02-filled');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(300);
  ok(`fields cleared after Add, tags kept (${await win.locator('.ne-tag').count()})`, (await field(0).innerText()).trim() === '' && (await win.locator('.ne-tag').count()) === 2);
  ok('focus back in the first field', await field(0).evaluate((el) => document.activeElement === el));

  // duplicate check
  await win.keyboard.type('Ohm <law>');
  await win.locator('.ne-dup').waitFor({ timeout: 3000 }).catch(() => {});
  ok('duplicate is flagged', await win.locator('.ne-dup').isVisible());
  await shot('add-03-duplicate');
  await field(0).evaluate((el) => { el.innerHTML = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });

  // pin a field: it keeps its content
  await win.getByRole('button', { name: 'Pin: keep after adding' }).nth(1).click();
  await field(0).click();
  await win.keyboard.type('Widerstand');
  await field(1).click();
  await win.keyboard.type('resistance');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(300);
  ok(`pinned Back kept: "${await field(1).innerText()}"`, (await field(1).innerText()).includes('resistance'));
  await win.getByRole('button', { name: 'Unpin: clear after adding' }).click();

  // note type chooser (Ctrl+N): reversed makes two cards
  await field(0).click();
  await win.keyboard.press('Control+n');
  await win.locator('.modal input').fill('reversed card');
  await shot('add-04-choose-type');
  await win.keyboard.press('Enter');
  ok(`type now: ${await win.locator('.add-chooser').nth(0).innerText()}`, (await win.locator('.add-chooser').nth(0).innerText()).includes('reversed'));
  await field(0).click();
  await win.keyboard.press('Control+a');
  await win.keyboard.type('Leistung');
  await field(1).click();
  await win.keyboard.press('Control+a');
  await win.keyboard.type('power');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(400);
  let d = await disk();
  const lastNote = d.notes[d.notes.length - 1];
  ok(`reversed note made ${d.cards.filter((c) => c.noteId === lastNote.id).length} cards`, d.cards.filter((c) => c.noteId === lastNote.id).length === 2);

  // deck chooser (Ctrl+D) with a new deck
  await win.keyboard.press('Control+d');
  await win.locator('.modal').getByRole('button', { name: 'Add deck' }).click();
  await win.locator('.modal input').fill('Vorkurs ET::Kapitel 1');
  await win.keyboard.press('Enter');
  ok(`deck now: ${await win.locator('.add-chooser').nth(1).innerText()}`, (await win.locator('.add-chooser').nth(1).innerText()) === 'Vorkurs ET::Kapitel 1');

  // cloze with keyboard; the MathJax chord; the HTML editor
  await win.keyboard.press('Control+n');
  await win.locator('.modal input').fill('Cloze');
  await win.keyboard.press('Enter');
  await field(0).click();
  await win.keyboard.type('Ohm');
  await win.keyboard.press('Shift+Home');
  await win.keyboard.press('Control+Shift+C');
  await win.keyboard.press('End');
  await win.keyboard.type(' and ');
  await win.keyboard.press('Control+m');
  await win.keyboard.press('Control+m');
  await win.keyboard.type('R^2');
  await win.keyboard.press('Control+Shift+X');
  const htmlSrc = await win.locator('.ne-html').first().inputValue();
  ok(`HTML editor: ${htmlSrc}`, htmlSrc.includes('{{c1::Ohm}}') && htmlSrc.includes(String.raw`\(R^2\)`));
  await shot('add-05-cloze-html');
  await win.keyboard.press('Control+Shift+P');
  await win.locator('.cards-preview-face').waitFor();
  ok('preview typesets formula and shows [...]', (await win.locator('.cards-preview-face .katex').count()) > 0 && (await win.locator('.cards-preview-face .cloze').innerText()).includes('['));
  await shot('add-06-preview');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(300);

  // attach a picture
  await win.keyboard.press('Control+n');
  await win.locator('.modal input').fill('Basic');
  await win.keyboard.press('Enter');
  await field(0).click();
  await win.keyboard.type('Symbol of a resistor:');
  await win.locator('.ne-tools input[type=file]').setInputFiles({ name: 'r.png', mimeType: 'image/png', buffer: Buffer.from(await win.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#2f5b8a'; g.fillRect(4, 6, 32, 8); return c.toDataURL('image/png').split(',')[1]; }), 'base64') });
  await win.locator('.ne-rich img').first().waitFor({ timeout: 5000 });
  ok('picture attached as data URL', (await win.locator('.ne-rich img').first().getAttribute('src')).startsWith('data:image/'));

  // Fields…: add a field
  await win.getByRole('button', { name: /Fields…/ }).click();
  await win.locator('.modal').getByRole('button', { name: 'Add', exact: true }).click();
  await win.locator('.modal input[aria-label="Field name"]').fill('Example');
  await win.keyboard.press('Enter');
  await shot('add-07-fields');
  await win.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await win.waitForTimeout(300);
  ok(`fields now: ${(await win.locator('.ne-field-name').allInnerTexts()).join(',')}`, (await win.locator('.ne-field').count()) === 3);
  ok('values kept after changing fields', (await field(0).innerText()).includes('resistor'));

  // Cards…: show Example on the back, live preview
  await win.getByRole('button', { name: /Cards…/ }).click();
  await win.locator('.modal').getByRole('tab', { name: 'Back template' }).click();
  await win.locator('.cards-code').fill('{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}{{#Example}}<p class="ex">e.g. {{Example}}</p>{{/Example}}');
  await win.locator('.modal').getByRole('tab', { name: 'Styling' }).click();
  await win.locator('.cards-code').fill('.card { font-size: 20px; text-align: center; color: var(--card-text); }\n.ex { color: #1e8449; }');
  await win.locator('.modal').getByRole('tab', { name: 'Back preview' }).click();
  ok(`preview: ${(await win.locator('.cards-preview-face .card').innerText()).replace(/\s+/g, ' ').slice(0, 60)}`, (await win.locator('.cards-preview-face .card').innerText()).includes('resistor'));
  await shot('add-08-cards');
  await win.locator('.modal').getByRole('button', { name: 'Save' }).click();
  await field(1).click();
  await win.keyboard.type('the zigzag');
  await field(2).click();
  await win.keyboard.type('R1 on a circuit diagram');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(300);

  // type-in-the-answer
  await win.keyboard.press('Control+n');
  await win.locator('.modal input').fill('type in');
  await win.keyboard.press('Enter');
  await field(0).click();
  await win.keyboard.type('Unit of resistance?');
  await field(1).click();
  await win.keyboard.type('Ohm');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(300);

  // history → Browse
  await win.getByRole('button', { name: /History/ }).click();
  const hist = await win.locator('.menu [role=menuitem]').allInnerTexts();
  ok(`history: ${hist.length} entries, first "${hist[0]}"`, hist.length >= 5 && hist[0].includes('Unit of resistance'));
  await shot('add-09-history');
  await win.keyboard.press('Escape');

  // Help (F1)
  await win.keyboard.press('F1');
  ok('help lists shortcuts', (await win.locator('.help-keys tr').count()) > 10);
  await win.keyboard.press('Escape');

  // study the type-in card
  d = await disk();
  ok(`collection: ${d.notes.length} notes, ${d.cards.length} cards, ${d.noteTypes.length} types`, d.notes.length === 9 && d.cards.length === 11);
  await win.locator('.st-tab', { hasText: 'Decks' }).click();
  await win.locator('.st-deck-name', { hasText: 'Kapitel 1' }).click();
  await win.getByRole('button', { name: 'Study now' }).click();
  for (let i = 0; i < 6; i++) {
    const q = await win.locator('.st-face .card').innerText();
    if (q.includes('Unit of resistance')) break;
    await win.keyboard.press('Space');
    await win.keyboard.press('4');
    await win.waitForTimeout(200);
  }
  const input = win.locator('.st-face input.typeans');
  ok('type-in box on the front', await input.isVisible());
  await input.fill('Ohn');
  await input.press('Enter');
  await win.locator('.st-face .typeans-result').waitFor();
  ok(`typed answer compared: ${await win.locator('.st-face .typeans-result').innerHTML()}`, (await win.locator('.st-face .typeans-bad').count()) === 1 && (await win.locator('.st-face .typeans-good').count()) >= 1);
  await shot('add-10-typein');
  await win.keyboard.press('3');
  await win.locator('.st-back').first().click();

  // Browse: edit a note, saved by itself
  await win.locator('.st-tab', { hasText: 'Browse' }).click();
  await win.locator('.st-search input').fill('Leistung');
  ok(`browse rows for a reversed note: ${await win.locator('.st-table tbody tr').count()}`, (await win.locator('.st-table tbody tr').count()) === 2);
  await win.locator('.st-table tbody tr').first().click();
  await win.locator('.st-editor .ne-rich').nth(1).click();
  await win.keyboard.press('End');
  await win.keyboard.type(' (P)');
  await win.waitForTimeout(800);
  d = await disk();
  ok('Browse edit saved', d.notes.some((n) => n.fields[1] === 'power (P)'));
  await shot('add-11-browse');
};

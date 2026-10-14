// Anki-style study flow on a fresh deck: node tests/drive-tauri.mjs tests/study.mjs
export default async ({ win, shot }) => {
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  await win.waitForTimeout(1500);
  const skip = win.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await win.getByRole('button', { name: 'New', exact: true }).click();
  await win.getByRole('menuitem', { name: /Flashcard deck/ }).click();
  await win.locator('.modal input').first().waitFor();
  await win.locator('.modal input').first().fill('Reaction mechanisms');
  await win.locator('.modal').getByRole('radio', { name: 'Flashcards', exact: true }).click();
  await win.getByRole('button', { name: 'Create', exact: true }).click();
  await win.waitForTimeout(1500);
  await win.getByRole('button', { name: 'Add page' }).first().click();
  await win.getByRole('button', { name: 'Add page' }).first().click();
  await win.waitForTimeout(500);

  const study = async () => {
    await win.locator('.toolbar').getByRole('button', { name: 'More', exact: true }).click();
    await win.getByRole('menuitem', { name: 'Study flashcards' }).click();
    await win.waitForTimeout(1200);
  };
  const counts = () => win.locator('.study-counts').innerText().catch(() => '(none)');
  const ivls = () => win.locator('.study-ivl').allInnerTexts();

  await study();
  console.log('start counts:', await counts());
  await shot('study-01-question');
  await win.keyboard.press('Space');
  await win.waitForTimeout(300);
  console.log('new card buttons:', await ivls());
  await shot('study-02-answer');
  await win.keyboard.press('3'); // good -> 10m
  await win.waitForTimeout(800);
  await win.keyboard.press('Space');
  await win.waitForTimeout(300);
  await win.keyboard.press('4'); // easy -> 4d
  await win.waitForTimeout(800);
  await win.keyboard.press('Space');
  await win.waitForTimeout(300);
  await win.keyboard.press('1'); // again -> 1m
  await win.waitForTimeout(800);
  console.log('after 3 answers:', await counts(), '| empty text:', await win.locator('.modal .empty p').innerText().catch(() => '-'));
  await shot('study-03-after');
  // closing and reopening keeps the schedule
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  await study();
  console.log('reopened:', await counts(), '| empty text:', await win.locator('.modal .empty p').innerText().catch(() => '-'));
  await shot('study-04-reopened');
};

export default async ({ win }) => {
  console.log('DEVICES', JSON.stringify(await win.evaluate(async () => (await window.gink.boot()).devices)), 'penKnown', await win.evaluate(() => window.__goodink.penKnown));
};

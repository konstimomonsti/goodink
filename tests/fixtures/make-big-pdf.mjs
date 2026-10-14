// A realistic lecture deck: 60 landscape slides with text, shapes and a filled diagram each.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fs from 'node:fs';
const doc = await PDFDocument.create();
const f = await doc.embedFont(StandardFonts.Helvetica);
const b = await doc.embedFont(StandardFonts.HelveticaBold);
for (let i = 0; i < 60; i++) {
  const p = doc.addPage([960, 540]);
  p.drawRectangle({ x: 0, y: 470, width: 960, height: 70, color: rgb(0.17, 0.35, 0.85) });
  p.drawText(`Lecture 7 — slide ${i + 1}: Cellular respiration`, { x: 40, y: 495, size: 26, font: b, color: rgb(1, 1, 1) });
  for (let k = 0; k < 6; k++) p.drawText(`• Key point ${k + 1} about glycolysis, the Krebs cycle and the electron transport chain (${i}.${k})`, { x: 40, y: 420 - k * 34, size: 16, font: f });
  for (let k = 0; k < 12; k++) p.drawCircle({ x: 700 + (k % 4) * 55, y: 120 + Math.floor(k / 4) * 55, size: 22, color: rgb(0.2 + k * 0.05, 0.6, 0.4), opacity: 0.8 });
}
fs.writeFileSync('tests/fixtures/big.pdf', await doc.save());
console.log('big.pdf written');

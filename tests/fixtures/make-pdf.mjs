// Builds a small multi-page PDF fixture with real text, an outline-free layout and one rotated page.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import fs from 'node:fs';
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const texts = [
  ['Cell Biology — Lecture 3', ['The mitochondrion produces ATP through oxidative phosphorylation.', 'Ribosomes translate messenger RNA into proteins.', 'The nucleus stores genetic information as chromatin.']],
  ['Photosynthesis', ['Chloroplasts capture light energy.', 'The Calvin cycle fixes carbon dioxide into sugars.', 'Thylakoid membranes host the light reactions.']],
  ['Review questions', ['1. What does the Golgi apparatus do?', '2. Name two functions of the cytoskeleton.', '3. Explain osmosis in your own words.']],
];
texts.forEach(([title, lines], i) => {
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(title, { x: 60, y: 760, size: 24, font: bold, color: rgb(0.1, 0.1, 0.2) });
  lines.forEach((l, k) => page.drawText(l, { x: 60, y: 700 - k * 28, size: 13, font }));
  page.drawRectangle({ x: 60, y: 300, width: 470, height: 200, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1.5 });
  page.drawText(`Page ${i + 1}`, { x: 280, y: 40, size: 10, font });
});
const land = doc.addPage([841.89, 595.28]);
land.drawText('Landscape diagram page', { x: 60, y: 520, size: 22, font: bold });
fs.writeFileSync('tests/fixtures/sample.pdf', await doc.save());
console.log('fixture written');

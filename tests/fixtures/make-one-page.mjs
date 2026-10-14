// One-page PDF fixture for "place a PDF onto a fixed page".
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'node:fs';
const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.HelveticaBold);
const p = d.addPage([595, 842]);
p.drawText('One-page handout', { x: 60, y: 760, size: 28, font: f });
p.drawText('Glycolysis happens in the cytoplasm.', { x: 60, y: 700, size: 14, font: f });
fs.writeFileSync('tests/fixtures/one-page.pdf', await d.save());
console.log('fixture written');

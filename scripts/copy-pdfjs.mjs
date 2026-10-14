// Copies pdf.js runtime data (CMaps, standard fonts, wasm decoders, ICC) into Vite's public dir.
import { cpSync, mkdirSync } from 'node:fs';
const out = 'src/renderer/public/pdfjs';
mkdirSync(out, { recursive: true });
for (const d of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) cpSync(`node_modules/pdfjs-dist/${d}`, `${out}/${d}`, { recursive: true });
console.log('pdf.js assets copied');

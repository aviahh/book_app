// Copies PDF.js runtime data (character maps, standard fonts, wasm decoders)
// into public/pdfjs so they are served — and cached offline — with the app.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'pdfjs-dist');
const dest = join(root, 'public', 'pdfjs');

if (!existsSync(src)) process.exit(0);
mkdirSync(dest, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  const from = join(src, dir);
  if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true });
}

// PDF.js 2.16 for older browsers (iOS 12): its legacy build, served as plain scripts.
const legacy = join(root, 'node_modules', 'pdfjs-legacy');
const legacyDest = join(root, 'public', 'pdfjs-legacy');
if (existsSync(legacy)) {
  mkdirSync(legacyDest, { recursive: true });
  for (const f of ['pdf.min.js', 'pdf.worker.min.js']) cpSync(join(legacy, 'legacy', 'build', f), join(legacyDest, f));
  for (const dir of ['cmaps', 'standard_fonts']) cpSync(join(legacy, dir), join(legacyDest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs and public/pdfjs-legacy');

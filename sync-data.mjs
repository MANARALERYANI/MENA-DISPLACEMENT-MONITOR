// Copies the pipeline output (data/data.json — the source of truth written by
// scripts/refresh_dtm.py) into public/ so Vite serves and bundles it. Runs
// automatically before `dev` and `build` (see package.json). Keeps the Python
// pipeline unchanged: it still writes only data/data.json.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, 'data', 'data.json');
const destDir = join(here, 'public', 'data');
const dest = join(destDir, 'data.json');

if (!existsSync(src)) {
  console.warn(`[sync-data] source not found: ${src} — skipping (run scripts/refresh_dtm.py)`);
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[sync-data] data/data.json → public/data/data.json`);

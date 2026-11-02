// Bundles the app into out/: main (ESM, Electron and Node built-ins external; taigent's core is imported at run
// time from dist/, see src/main/taigent.ts), the sandboxed preload (CommonJS, as Electron requires) and the renderer
// (one IIFE with marked + DOMPurify, plus index.html and styles.css). Type checking is `tsc --noEmit` (npm run build).

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: 'linked', logLevel: 'warning', external: ['electron'] };

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer'), { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(out, 'main.js'), format: 'esm' }),
  build({ ...common, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(out, 'preload.cjs'), format: 'cjs' }),
  build({
    entryPoints: [join(root, 'src/renderer/renderer.ts')],
    outfile: join(out, 'renderer/renderer.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    sourcemap: 'linked',
    logLevel: 'warning',
  }),
  cp(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html')),
  cp(join(root, 'src/renderer/styles.css'), join(out, 'renderer/styles.css')),
]);
console.log('built out/');

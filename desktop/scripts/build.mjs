// Bundles the app into out/: main (ESM, Electron and Node built-ins external; taigent's core is imported at run
// time from dist/, see src/main/taigent.ts; node-pty is loaded at run time from node_modules, see
// src/main/terminal.ts), the sandboxed preload (CommonJS, as Electron requires) and the renderer: one IIFE of the
// React app (src/renderer/main.tsx, shadcn/ui components, marked, DOMPurify, xterm.js), styles.css compiled by the
// Tailwind CLI from src/renderer/globals.css, index.html, xterm.css and the vendored Geist and Geist Mono fonts in
// fonts/ (OFL-1.1, OFL.txt). Type checking is `tsc --noEmit` on
// tsconfig.json (main, preload) and src/renderer/tsconfig.json (npm run build).

import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const common = { bundle: true, platform: 'node', target: 'node24', sourcemap: 'linked', logLevel: 'warning', external: ['electron'] };

/** Compiles globals.css (Tailwind v4 + the shadcn/ui tokens) to out/renderer/styles.css. */
function tailwind() {
  const cli = join(root, 'node_modules/@tailwindcss/cli/dist/index.mjs');
  const args = [cli, '-i', join(root, 'src/renderer/globals.css'), '-o', join(out, 'renderer/styles.css'), '--minify'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tailwindcss exited with ${code}\n${stderr}`))));
  });
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'renderer/fonts'), { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(out, 'main.js'), format: 'esm' }),
  build({ ...common, entryPoints: [join(root, 'src/preload/preload.ts')], outfile: join(out, 'preload.cjs'), format: 'cjs' }),
  build({
    entryPoints: [join(root, 'src/renderer/main.tsx')],
    outfile: join(out, 'renderer/renderer.js'),
    tsconfig: join(root, 'src/renderer/tsconfig.json'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minifySyntax: true,
    sourcemap: 'linked',
    logLevel: 'warning',
  }),
  tailwind(),
  cp(join(root, 'src/renderer/index.html'), join(out, 'renderer/index.html')),
  cp(join(root, 'src/renderer/fonts'), join(out, 'renderer/fonts'), { recursive: true }),
  cp(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), join(out, 'renderer/xterm.css')),
]);
console.log('built out/');

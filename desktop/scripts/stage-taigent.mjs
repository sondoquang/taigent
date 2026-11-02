// Stages the taigent runtime the packaged app ships as `resources/taigent` (electron-builder `extraResources`):
//
//   stage/taigent/node_modules/taigent/{bin,dist,package.json}   the CLI and the core (src/main/taigent.ts)
//   stage/taigent/node_modules/<dependency>                      its runtime dependencies, copied from the
//                                                                repository's node_modules with their own
//                                                                dependencies and the installed N-API prebuilt
//
// Under `node_modules/`, bin/taigent.js runs dist/ (not src/), so the CLI needs only this copy and the app's own
// executable in Node mode. taiga-mcp-server is left out: it only serves `taigent mcp`, which the app never runs.

import { cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const stage = join(desktop, 'stage', 'taigent', 'node_modules');
const LEFT_OUT = new Set(['taiga-mcp-server']);

const exists = (path) => stat(path).then(() => true, () => false);

for (const file of ['dist/cli.js', 'dist/review.js', 'dist/login.js']) {
  if (!(await exists(join(repo, file)))) {
    console.error(`missing ${file}: run \`npm run build\` at the taigent repository root first`);
    process.exit(1);
  }
}

await rm(join(desktop, 'stage'), { recursive: true, force: true });
await mkdir(join(stage, 'taigent'), { recursive: true });
for (const entry of ['bin', 'dist', 'package.json', 'LICENSE']) {
  await cp(join(repo, entry), join(stage, 'taigent', entry), { recursive: true });
}

/** Copies `name` and, transitively, the dependencies it declares that are installed (optional ones may be absent). */
async function copyPackage(name, copied) {
  if (copied.has(name)) return;
  const source = join(repo, 'node_modules', name);
  if (!(await exists(source))) return;
  copied.add(name);
  await cp(source, join(stage, name), { recursive: true, dereference: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    await copyPackage(dependency, copied);
  }
}

const root = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const copied = new Set();
for (const dependency of Object.keys(root.dependencies ?? {})) {
  if (!LEFT_OUT.has(dependency)) await copyPackage(dependency, copied);
}
console.log(`staged taigent ${root.version} with ${[...copied].join(', ')} in ${join(desktop, 'stage', 'taigent')}`);

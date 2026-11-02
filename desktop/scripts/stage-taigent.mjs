// Stages the taigent runtime the packaged app ships as `resources/taigent` (electron-builder `extraResources`):
//
//   stage/taigent/node_modules/taigent/   package.json, LICENSE and every file of its `files` list, as npm would
//                                         install it: the CLI and the core (bin/, dist/; src/main/taigent.ts),
//                                         the docs the skills cite, and what `taigent init` installs into a repository
//                                         (the Taigent skills, the headless kit with run-skill)
//   stage/taigent/node_modules/<dependency>   its runtime dependencies, copied from the repository's node_modules
//                                         with their own dependencies and the installed N-API prebuilt
//
// Under `node_modules/`, bin/taigent.js runs dist/ (not src/), so the CLI needs only this copy and the app's own
// executable in Node mode. taiga-mcp-server is left out: it only serves `taigent mcp`, which the app never runs.

import { cp, glob, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const stage = join(desktop, 'stage', 'taigent', 'node_modules');
const LEFT_OUT = new Set(['taiga-mcp-server']);

const exists = (path) => stat(path).then(() => true, () => false);

for (const file of ['dist/cli.js', 'dist/review.js', 'dist/edit.js', 'dist/login.js']) {
  if (!(await exists(join(repo, file)))) {
    console.error(`missing ${file}: run \`npm run build\` at the taigent repository root first`);
    process.exit(1);
  }
}

const root = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
await rm(join(desktop, 'stage'), { recursive: true, force: true });
await mkdir(join(stage, 'taigent'), { recursive: true });
for (const entry of ['package.json', 'LICENSE']) await cp(join(repo, entry), join(stage, 'taigent', entry));
const patterns = root.files.map((pattern) => (pattern.endsWith('/') ? `${pattern}**` : pattern));
for await (const entry of glob(patterns, { cwd: repo, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const file = relative(repo, join(entry.parentPath, entry.name));
  await mkdir(dirname(join(stage, 'taigent', file)), { recursive: true });
  await cp(join(repo, file), join(stage, 'taigent', file));
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

const copied = new Set();
for (const dependency of Object.keys(root.dependencies ?? {})) {
  if (!LEFT_OUT.has(dependency)) await copyPackage(dependency, copied);
}
console.log(`staged taigent ${root.version} with ${[...copied].join(', ')} in ${join(desktop, 'stage', 'taigent')}`);

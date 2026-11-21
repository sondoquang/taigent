// The npm package: what `npm i -g taigent` installs must run without compiling and hold everything `taigent setup --project`
// copies and every doc the shipped skills and headless kit cite. Checked on the real `npm pack` file list.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OFFLINE, runTaigent } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
/** Files `setup --project` writes that it generates rather than copies from the package. */
const GENERATED = ['.mcp.json', '.codex/config.toml', 'package.json', '.gitignore'];

/** `npm pack --dry-run` of the repository (runs `prepack`): the paths the published tarball holds. */
async function packedFiles(): Promise<string[]> {
  const npm = process.env.npm_execpath;
  const args = ['pack', '--dry-run', '--json'];
  const { stdout } = npm
    ? await promisify(execFile)(process.execPath, [npm, ...args], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 })
    : await promisify(execFile)('npm', args, { cwd: REPO_ROOT, shell: true, maxBuffer: 16 * 1024 * 1024 });
  const [pack] = JSON.parse(stdout.slice(stdout.indexOf('['))) as [{ files: { path: string }[] }];
  return pack.files.map(({ path }) => path.replaceAll('\\', '/'));
}

test('installing from npm never compiles: no install-time script, the build runs before packing', () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(PACKAGE.scripts[script], undefined, script);
  assert.equal(PACKAGE.scripts.prepack, 'npm run build');
});

test('the package holds the CLI build, everything setup --project copies and every doc the shipped skills and kit cite', async (t) => {
  const files = new Set(await packedFiles());
  assert.ok(files.has('bin/taigent.js'));
  assert.ok(files.has('dist/cli.js'), 'dist/cli.js');

  const empty = await mkdtemp(join(tmpdir(), 'taigent-package-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const setup = await runTaigent(['setup', '--project', '--dry-run', '--json'], { env: OFFLINE, cwd: empty });
  const copied = setup.json<{ files: { path: string }[] }>().files.map(({ path }) => path).filter((path) => !GENERATED.includes(path));
  assert.ok(copied.some((path) => path.startsWith('.agents/skills/')), setup.stdout);
  for (const path of copied) {
    const source = path.replace(/^\.claude\/skills\//, '.agents/skills/');
    assert.ok(files.has(source), `${source} (copied by setup --project) is not in the package`);
  }

  const cited = new Set<string>();
  for (const file of files) {
    if (!/^(\.agents|tools|\.codex)\//.test(file)) continue;
    for (const [doc] of (await readFile(join(REPO_ROOT, file), 'utf8')).matchAll(/docs\/[\w./-]*\w\.md/g)) cited.add(doc);
  }
  assert.ok(cited.has('docs/cli.md'), [...cited].join(', '));
  for (const doc of cited) {
    const exists = await access(join(REPO_ROOT, doc)).then(() => true, () => false);
    // Example paths (e.g. a project's own docs/specs/auth.md) are not taigent docs.
    if (exists) assert.ok(files.has(doc), `${doc} (cited by a shipped skill or the kit) is not in the package`);
  }
});

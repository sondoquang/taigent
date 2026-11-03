import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadProject } from '../src/manifest/project.ts';
import { type ProjectSettings, readProjectSettings, saveProjectSettings } from '../src/project-settings.ts';

const SETTINGS: ProjectSettings = {
  name: 'Vigo - Core Mapping',
  description: 'Mapping service of Vigo.',
  template: 'scrum',
  isPrivate: true,
  modules: ['epics', 'backlog', 'wiki'],
  existing: false,
};

const EXISTING = `# Written by the agent (taiga-bootstrap-project).
name: Vigo - Core Mapping
slug: vigo-core-mapping
description: Old description.
template: kanban
is_private: true
modules: [epics, kanban, wiki]  # what the team uses
tags:
  - name: type:feature
    color: "#2E7D32"
members:
  - username: alice
    role: Back
wiki_home: |
  # Home
`;

async function manifestsRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'taigent-project-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeExisting(root: string, text = EXISTING): Promise<string> {
  await mkdir(join(root, 'vigo-core-mapping'), { recursive: true });
  const path = join(root, 'vigo-core-mapping', 'project.yaml');
  await writeFile(path, text);
  return path;
}

test('a new project.yaml goes into the directory of the slug Taiga derives from the name, and validates', async (t) => {
  const root = await manifestsRoot(t);

  const result = await saveProjectSettings(root, SETTINGS, { baseDigest: null });

  assert.equal(result.status, 'saved');
  assert.equal(result.status === 'saved' && result.slug, 'vigo-core-mapping');
  const manifest = await loadProject(join(root, 'vigo-core-mapping', 'project.yaml'), 'vigo-core-mapping');
  assert.deepEqual(
    { name: manifest.name, slug: manifest.slug, description: manifest.description, template: manifest.template, isPrivate: manifest.isPrivate, modules: manifest.modules },
    { name: 'Vigo - Core Mapping', slug: 'vigo-core-mapping', description: 'Mapping service of Vigo.', template: 'scrum', isPrivate: true, modules: ['epics', 'backlog', 'wiki'] },
  );
  const read = await readProjectSettings(root, 'vigo-core-mapping');
  assert.deepEqual(read.settings, SETTINGS);
  assert.equal(read.digest, result.status === 'saved' && result.digest);
  assert.deepEqual(read.issues, []);
});

test('a project named from Taiga is saved with existing: true, so its legacy name and slug validate', async (t) => {
  const root = await manifestsRoot(t);

  const result = await saveProjectSettings(root, { ...SETTINGS, name: 'Core Mapping (cũ)', existing: true }, { slug: 'vigo-core-mapping', baseDigest: null });

  assert.equal(result.status, 'saved');
  const manifest = await loadProject(join(root, 'vigo-core-mapping', 'project.yaml'), 'vigo-core-mapping');
  assert.equal(manifest.existing, true);
  const read = await readProjectSettings(root, 'vigo-core-mapping');
  assert.equal(read.settings?.existing, true);
  assert.deepEqual(read.issues, []);
});

test('saving over an existing project.yaml changes the form fields only and keeps comments, tags, members and wiki_home', async (t) => {
  const root = await manifestsRoot(t);
  const path = await writeExisting(root);
  const before = await readProjectSettings(root, 'vigo-core-mapping');
  assert.deepEqual(before.settings, { name: 'Vigo - Core Mapping', description: 'Old description.', template: 'kanban', isPrivate: true, modules: ['epics', 'kanban', 'wiki'], existing: false });

  const result = await saveProjectSettings(root, { ...SETTINGS, description: 'New description.', isPrivate: false }, { slug: 'vigo-core-mapping', baseDigest: before.digest });

  assert.equal(result.status, 'saved');
  const text = await readFile(path, 'utf8');
  assert.match(text, /^# Written by the agent \(taiga-bootstrap-project\)\.$/m);
  assert.match(text, /^description: New description\.$/m);
  assert.match(text, /^template: scrum$/m);
  assert.match(text, /^is_private: false$/m);
  assert.match(text, /^ {2}- username: alice$/m);
  assert.match(text, /^ {4}color: "#2E7D32"$/m);
  assert.match(text, /^wiki_home: \|\n {2}# Home$/m);
  const manifest = await loadProject(path, 'vigo-core-mapping');
  assert.deepEqual(manifest.members, [{ username: 'alice', role: 'Back' }]);
  assert.deepEqual(manifest.modules, ['epics', 'backlog', 'wiki']);
  assert.deepEqual(await readdir(join(root, 'vigo-core-mapping')), ['project.yaml']);
});

test('a project.yaml changed since the form read it is not overwritten', async (t) => {
  const root = await manifestsRoot(t);
  const path = await writeExisting(root);
  const before = await readProjectSettings(root, 'vigo-core-mapping');
  const agentEdit = EXISTING.replace('Old description.', 'Agent description.');
  await writeFile(path, agentEdit);

  const result = await saveProjectSettings(root, SETTINGS, { slug: 'vigo-core-mapping', baseDigest: before.digest });

  assert.equal(result.status, 'conflict');
  assert.equal(result.status === 'conflict' && result.current, (await readProjectSettings(root, 'vigo-core-mapping')).digest);
  assert.equal(await readFile(path, 'utf8'), agentEdit);
  // A form opened for a new project conflicts with a file created meanwhile, too.
  assert.equal((await saveProjectSettings(root, SETTINGS, { baseDigest: null })).status, 'conflict');
});

test('form values breaking a convention are refused with their path and rule, and nothing is written', async (t) => {
  const root = await manifestsRoot(t);
  const path = await writeExisting(root);
  const before = await readProjectSettings(root, 'vigo-core-mapping');

  const renamed = await saveProjectSettings(root, { ...SETTINGS, name: 'Vigo - Core Maps' }, { slug: 'vigo-core-mapping', baseDigest: before.digest });
  const broken = await saveProjectSettings(root, { ...SETTINGS, name: 'Vigo Core Mapping', description: ' ', modules: ['backlog'] }, { slug: 'vigo-core-mapping', baseDigest: before.digest });

  assert.equal(renamed.status, 'invalid');
  assert.deepEqual(renamed.status === 'invalid' && renamed.issues.map(({ path, rule }) => ({ path, rule })), [{ path: 'slug', rule: 'project-slug' }]);
  assert.equal(broken.status, 'invalid');
  assert.deepEqual(
    new Set(broken.status === 'invalid' ? broken.issues.map(({ path, rule }) => `${path} ${rule}`) : []),
    new Set(['name project-name', 'description required', 'modules module-required']),
  );
  assert.ok(broken.status === 'invalid' && broken.issues.every((issue) => issue.file === path));
  assert.equal(await readFile(path, 'utf8'), EXISTING);
  assert.deepEqual(await readdir(join(root, 'vigo-core-mapping')), ['project.yaml']);
});

test('a new project whose name gives no valid slug writes nothing', async (t) => {
  const root = await manifestsRoot(t);

  const result = await saveProjectSettings(root, { ...SETTINGS, name: '' }, { baseDigest: null });
  const traversal = await saveProjectSettings(root, SETTINGS, { slug: '../outside', baseDigest: null });

  assert.equal(result.status, 'invalid');
  assert.deepEqual(result.status === 'invalid' && result.issues.map(({ path, rule }) => ({ path, rule })), [{ path: 'slug', rule: 'project-slug' }]);
  assert.equal(traversal.status, 'invalid');
  assert.deepEqual(await readdir(root), []);
});

test('problems outside the form fields are reported on read and do not block a save', async (t) => {
  const root = await manifestsRoot(t);
  await writeExisting(root, EXISTING.replace('type:feature', 'feature'));

  const read = await readProjectSettings(root, 'vigo-core-mapping');
  const result = await saveProjectSettings(root, SETTINGS, { slug: 'vigo-core-mapping', baseDigest: read.digest });

  assert.deepEqual(read.issues.map(({ path }) => path), ['tags[0].name']);
  assert.equal(result.status, 'saved');
});

test('reading a project without project.yaml gives no settings and no digest', async (t) => {
  const root = await manifestsRoot(t);

  assert.deepEqual(await readProjectSettings(root, 'vigo-core-mapping'), { slug: 'vigo-core-mapping', digest: null, settings: null, issues: [] });
});

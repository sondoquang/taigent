import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { startHarness, writes, type Harness } from './support/harness.ts';

// TAIGENT_READ_ONLY=1 (set by Taigent Desktop on its headless skill runs): every command that writes to Taiga refuses
// with exit 2 before contacting it; reads, plans and dry runs still work.

const SLUG = 'demo-portal';
const READ_ONLY = { env: { TAIGENT_READ_ONLY: '1' } };

const PROJECT_YAML = `name: Demo - Portal
slug: demo-portal
description: Demo portal.
template: scrum
modules: [epics, wiki]
`;

const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
`;

const DOCS = `wiki:
  - slug: spec-auth
    file: pages/spec-auth.md
`;

async function setup(t: Parameters<typeof startHarness>[0]): Promise<{ h: Harness; ref: number }> {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: SLUG, name: 'Demo - Portal', members: [h.fake.user.id], admins: [h.fake.user.id] });
  const story = Object.assign(h.fake.addUserStory({ project: project.id, subject: 'Login form' }), { assigned_users: [h.fake.user.id] });
  await h.writeManifest(SLUG, 'project.yaml', PROJECT_YAML);
  await h.writeManifest(SLUG, 'backlog.yaml', BACKLOG);
  await h.writeManifest(SLUG, 'docs.yaml', DOCS);
  await mkdir(join(h.manifestsDir, SLUG, 'pages'));
  await writeFile(join(h.manifestsDir, SLUG, 'pages', 'spec-auth.md'), '# Auth\n');
  return { h, ref: story.ref };
}

test('under TAIGENT_READ_ONLY every Taiga write refuses with exit 2 and sends nothing to Taiga', async (t) => {
  const { h, ref } = await setup(t);
  const refused = [
    ['apply', '--project', SLUG, '--yes'],
    ['upload', '--project', SLUG, '--yes'],
    ['bootstrap', '--project', SLUG, '--yes'],
    ['status', '--project', SLUG, String(ref), 'Done'],
    ['comment', '--project', SLUG, String(ref), 'Looks good'],
  ];
  const before = h.fake.requests.length;
  for (const args of refused) {
    const text = await h.taigent(args, READ_ONLY);
    assert.equal(text.code, 2, `${args[0]}: ${text.stderr}`);
    assert.match(text.stderr, new RegExp(`taigent: ${args[0]} writes to Taiga.*TAIGENT_READ_ONLY`));
    const json = await h.taigent([...args, '--json'], READ_ONLY);
    assert.equal(json.code, 2, json.stderr);
    assert.equal(json.json<{ error: { kind: string } }>().error.kind, 'read-only');
  }
  assert.equal(h.fake.requests.length, before, 'refused before contacting Taiga');
  assert.deepEqual(writes(h.fake), []);
});

test('under TAIGENT_READ_ONLY validate, preview, plan and --dry-run still work', async (t) => {
  const { h } = await setup(t);
  for (const args of [
    ['validate', '--project', SLUG],
    ['preview', '--project', SLUG],
  ]) {
    const result = await h.taigent(args, READ_ONLY);
    assert.equal(result.code, 0, `${args[0]}: ${result.stderr}`);
  }
  for (const args of [
    ['plan', '--project', SLUG],
    ['apply', '--project', SLUG, '--dry-run'],
    ['apply', '--project', SLUG, '--yes', '--dry-run'],
    ['upload', '--project', SLUG, '--dry-run'],
  ]) {
    const result = await h.taigent(args, READ_ONLY);
    assert.equal(result.code, 3, `${args.join(' ')}: ${result.stderr}`);
  }
  // The project already has everything project.yaml declares: nothing to do.
  const bootstrap = await h.taigent(['bootstrap', '--project', SLUG, '--dry-run'], READ_ONLY);
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  assert.deepEqual(writes(h.fake), []);
});

test('TAIGENT_READ_ONLY unset or 0 lets the writes through', async (t) => {
  const { h, ref } = await setup(t);
  const result = await h.taigent(['comment', '--project', SLUG, String(ref), 'Looks good'], { env: { TAIGENT_READ_ONLY: '0' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.comments.length, 1);
});

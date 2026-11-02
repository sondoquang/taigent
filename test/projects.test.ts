import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

interface ProjectJson {
  id: number;
  slug: string;
  name: string;
  admin: boolean;
  manifest: boolean;
}

interface ProjectDetailJson {
  project: ProjectJson;
  issueTypes: string[];
  severities: string[];
  priorities: string[];
  storyStatuses: { name: string; isClosed: boolean }[];
}

/** Projects of the fake user (admin of one, plain member of the other) and two the user is not a member of. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  return {
    alpha: fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other], admins: [me] }),
    beta: fake.addProject({ slug: 'beta', name: 'Beta', members: [other, me], admins: [other] }),
    publicOther: fake.addProject({ slug: 'public-other', name: 'Public', members: [other], is_private: false }),
    privateOther: fake.addProject({ slug: 'private-other', name: 'Private', members: [other] }),
  };
}

test('projects lists only the projects the user is a member of, with admin rights and the manifest flag', async (t) => {
  const h = await startHarness(t);
  const { alpha, beta } = seed(h.fake);
  await h.writeManifest('alpha', 'backlog.yaml', 'epics: []\n');
  // A manifest directory of a project the user cannot see does not show it.
  await h.writeManifest('private-other', 'backlog.yaml', 'epics: []\n');

  const result = await h.taigent(['projects', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<{ projects: ProjectJson[] }>().projects, [
    { id: alpha.id, slug: 'alpha', name: 'Alpha', admin: true, manifest: true },
    { id: beta.id, slug: 'beta', name: 'Beta', admin: false, manifest: false },
  ]);
  assert.deepEqual(writes(h.fake), []);
});

test('projects reads the manifest flag from TAIGENT_MANIFESTS_DIR, and an empty directory counts', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  await mkdir(join(h.cwd, 'manifests', 'beta'), { recursive: true });

  const result = await h.taigent(['projects', '--json'], { env: { TAIGENT_MANIFESTS_DIR: 'manifests' } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.json<{ projects: ProjectJson[] }>().projects.map(({ slug, manifest }) => ({ slug, manifest })),
    [
      { slug: 'alpha', manifest: false },
      { slug: 'beta', manifest: true },
    ],
  );
});

test('projects prints one line per project in text form', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  await h.writeManifest('alpha', 'project.yaml', 'name: Alpha\n');

  const result = await h.taigent(['projects']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /alpha.*Alpha.*admin.*taiga[\\/]alpha/);
  assert.match(result.stdout, /beta.*Beta.*no manifest/);
  assert.doesNotMatch(result.stdout, /public-other|private-other/);
});

test('projects --project prints the issue values and user story statuses of the project, in Taiga order', async (t) => {
  const h = await startHarness(t);
  const { alpha, beta } = seed(h.fake);
  // A value added on Taiga and moved to the front: order wins over creation.
  h.fake.state.severities.push({ id: 9001, project: beta.id, name: 'Blocker', order: 0, color: '#000000' });
  h.fake.state.priorities.find((p) => p.project === beta.id && p.name === 'Low')!.order = 9;
  h.fake.state.storyStatuses.find((s) => s.project === beta.id && s.name === 'Ready for test')!.order = 0;
  await h.writeManifest('beta', 'backlog.yaml', 'epics: []\n');

  const result = await h.taigent(['projects', '--project', 'beta', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<ProjectDetailJson>(), {
    project: { id: beta.id, slug: 'beta', name: 'Beta', admin: false, manifest: true },
    issueTypes: ['Bug', 'Question', 'Enhancement'],
    severities: ['Blocker', 'Wishlist', 'Minor', 'Normal', 'Important', 'Critical'],
    priorities: ['Normal', 'High', 'Low'],
    storyStatuses: [
      { name: 'Ready for test', isClosed: false },
      { name: 'New', isClosed: false },
      { name: 'Ready', isClosed: false },
      { name: 'In progress', isClosed: false },
      { name: 'Done', isClosed: true },
      { name: 'Archived', isClosed: true },
    ],
  });
  const text = await h.taigent(['projects', '--project', 'alpha']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`alpha.*Alpha.*id ${alpha.id}`));
  assert.match(text.stdout, /Issue types: Bug, Question, Enhancement/);
  assert.match(text.stdout, /Severities: Wishlist, Minor, Normal, Important, Critical/);
  assert.match(text.stdout, /Priorities: Low, Normal, High/);
  assert.match(text.stdout, /User story statuses: New, Ready, In progress, Ready for test, Done \(closed\), Archived \(closed\)/);
  assert.deepEqual(writes(h.fake), []);
});

test('projects --project with a project the user cannot see is a Taiga error (exit 5)', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['projects', '--project', 'private-other', '--json']);

  assert.equal(result.code, 5, result.stderr);
  assert.equal(result.json<{ error: { kind: string } }>().error.kind, 'taiga');
  assert.match(result.stderr, /project "private-other" not found/);
});

test('projects with a login Taiga refuses is a Taiga error (exit 5)', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['projects', '--json'], { env: { TAIGA_PASSWORD: 'wrong-password' } });

  assert.equal(result.code, 5, result.stderr);
  assert.equal(result.json<{ error: { kind: string } }>().error.kind, 'taiga');
  assert.match(result.stderr, /TAIGA_USERNAME and TAIGA_PASSWORD/);
});

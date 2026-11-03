// Baseline and remote edits: apply records in state.json the managed values it last wrote or accepted for each item;
// plan compares the manifest (M) and Taiga (T) against that baseline (B) and blocks items whose Taiga values changed
// behind taigent's back. One test per row of the three-way table (spec #53), plus the migration of an older state.json
// and the fields that never block.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlockedItem, Plan } from '../src/planner.ts';
import type { FakeEpic } from './support/fake-taiga.ts';
import { startHarness, writes, type Harness } from './support/harness.ts';

const EXIT_BLOCKED = 6;

/** One epic AUTH; `subject` replaces its subject. */
function backlog(subject = 'Authentication', extra = ''): string {
  return `epics:
  - key: AUTH
    subject: ${subject}
    description: Users can sign in.
    tags: [type:feature, area:auth]
${extra}`;
}

const BASELINE = { subject: 'Authentication', description: 'Users can sign in.', tags: ['type:feature', 'area:auth'], custom_attributes: {} };

interface BlockedError {
  error: { kind: string; message: string; blocked: BlockedItem[] };
}

/** Applies backlog() to an empty project, so AUTH exists on Taiga with a baseline. Returns the epic on the fake. */
async function applied(h: Harness): Promise<FakeEpic> {
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', backlog());
  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(result.code, 0, result.stderr);
  return h.fake.state.epics[0]!;
}

/** Seeds AUTH on the fake as an older taigent created it (tagged, values `subject`), with no state.json. */
function seeded(h: Harness, subject = 'Authentication'): FakeEpic {
  const project = h.fake.addProject({ slug: 'demo' });
  return h.fake.addEpic({ project: project.id, subject, description: 'Users can sign in.', tags: ['type:feature', 'area:auth', 'src:auth'] });
}

test('apply records the baseline of each item it creates in state.json', async (t) => {
  const h = await startHarness(t);
  const epic = await applied(h);

  assert.deepEqual((await h.readState('demo'))?.items.AUTH, { type: 'epic', id: epic.id, ref: epic.ref, version: epic.version, baseline: BASELINE });
});

test('baseline present, Taiga and manifest unchanged: skip, nothing blocked', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  h.fake.requests.length = 0;

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(plan.code, 0, plan.stderr);
  const { operations, blocked } = plan.json<Plan>();
  assert.deepEqual(operations.map((op) => [op.action, op.key]), [['skip', 'AUTH']]);
  assert.deepEqual(blocked, []);
});

test('baseline present, manifest changed: update, and apply moves the baseline to the written values', async (t) => {
  const h = await startHarness(t);
  const epic = await applied(h);
  await h.writeManifest('demo', 'backlog.yaml', backlog('Sign-in'));

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const { operations, blocked } = plan.json<Plan>();
  assert.deepEqual(operations.map((op) => [op.action, op.key, op.action === 'update' ? Object.keys(op.changes) : []]), [['update', 'AUTH', ['subject']]]);
  assert.deepEqual(blocked, []);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.equal(epic.subject, 'Sign-in');
  assert.deepEqual((await h.readState('demo'))?.items.AUTH?.baseline, { ...BASELINE, subject: 'Sign-in' });
});

test('baseline present, Taiga changed, manifest unchanged: blocked as a remote edit; apply --yes exits 6 and writes nothing', async (t) => {
  const h = await startHarness(t);
  const epic = await applied(h);
  h.fake.editItem(epic, { subject: 'Login' });
  // Another change apply would make, to show that a blocked item stops the whole apply.
  await h.writeManifest('demo', 'backlog.yaml', backlog('Authentication', '  - key: BILLING\n    subject: Billing\n'));
  const before = await h.readState('demo');
  h.fake.requests.length = 0;

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, EXIT_BLOCKED, plan.stderr);
  const json = plan.json<Plan>();
  assert.deepEqual(json.blocked, [
    { kind: 'remote-edit', type: 'epic', key: 'AUTH', id: epic.id, ref: epic.ref, fields: { subject: { baseline: 'Authentication', taiga: 'Login', manifest: 'Authentication' } } },
  ]);
  assert.deepEqual(json.operations.map((op) => [op.action, op.key]), [['create', 'BILLING']]);
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(text.code, EXIT_BLOCKED);
  assert.match(text.stdout, /remote edit epic AUTH .*subject/);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(apply.code, EXIT_BLOCKED, apply.stderr);
  const { error } = apply.json<BlockedError>();
  assert.equal(error.kind, 'blocked');
  assert.deepEqual(error.blocked, json.blocked);
  assert.match(apply.stderr, /AUTH/);
  assert.deepEqual(writes(h.fake), []);
  assert.equal(epic.subject, 'Login');
  assert.equal(h.fake.state.epics.length, 1);
  assert.deepEqual(await h.readState('demo'), before);
});

test('baseline present, Taiga and manifest changed the same way: skip, and apply refreshes the baseline', async (t) => {
  const h = await startHarness(t);
  const epic = await applied(h);
  h.fake.editItem(epic, { subject: 'Login' });
  await h.writeManifest('demo', 'backlog.yaml', backlog('Login'));
  h.fake.requests.length = 0;

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  const { operations, blocked } = plan.json<Plan>();
  assert.deepEqual(operations.map((op) => [op.action, op.key]), [['skip', 'AUTH']]);
  assert.deepEqual(blocked, []);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.deepEqual(writes(h.fake), []);
  assert.deepEqual((await h.readState('demo'))?.items.AUTH?.baseline, { ...BASELINE, subject: 'Login' });
});

test('baseline present, Taiga and manifest changed differently: blocked as a conflict with all three versions', async (t) => {
  const h = await startHarness(t);
  const epic = await applied(h);
  h.fake.editItem(epic, { subject: 'Login' });
  await h.writeManifest('demo', 'backlog.yaml', backlog('Sign-in'));
  h.fake.requests.length = 0;

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, EXIT_BLOCKED, plan.stderr);
  const { operations, blocked } = plan.json<Plan>();
  assert.deepEqual(operations, []);
  assert.deepEqual(blocked, [
    { kind: 'conflict', type: 'epic', key: 'AUTH', id: epic.id, ref: epic.ref, fields: { subject: { baseline: 'Authentication', taiga: 'Login', manifest: 'Sign-in' } } },
  ]);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, EXIT_BLOCKED);
  assert.deepEqual(writes(h.fake), []);
  assert.equal(epic.subject, 'Login');
});

test('no baseline, manifest equal to Taiga: skip, and apply records the baseline without writing to Taiga', async (t) => {
  const h = await startHarness(t);
  const epic = seeded(h);
  await h.writeManifest('demo', 'backlog.yaml', backlog());

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.deepEqual(plan.json<Plan>().blocked, []);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.deepEqual(writes(h.fake), []);
  assert.deepEqual((await h.readState('demo'))?.items.AUTH, { type: 'epic', id: epic.id, ref: epic.ref, version: epic.version, baseline: BASELINE });
});

test('no baseline, manifest different from Taiga: blocked as unknown with both versions', async (t) => {
  const h = await startHarness(t);
  const epic = seeded(h, 'Login');
  await h.writeManifest('demo', 'backlog.yaml', backlog());

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, EXIT_BLOCKED, plan.stderr);
  assert.deepEqual(plan.json<Plan>().blocked, [
    { kind: 'unknown', type: 'epic', key: 'AUTH', id: epic.id, ref: epic.ref, fields: { subject: { taiga: 'Login', manifest: 'Authentication' } } },
  ]);

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, EXIT_BLOCKED);
  assert.deepEqual(writes(h.fake), []);
  assert.equal(await h.readState('demo'), undefined);
});

test('an older state.json without baselines is migrated by apply when the manifest equals Taiga', async (t) => {
  const h = await startHarness(t);
  const epic = seeded(h);
  await h.writeManifest('demo', 'backlog.yaml', backlog());
  const project = h.fake.state.projects[0]!;
  await writeFile(
    join(h.manifestsDir, 'demo', 'state.json'),
    `${JSON.stringify({ project: { id: project.id, slug: 'demo' }, items: { AUTH: { type: 'epic', id: epic.id, ref: epic.ref, version: epic.version } } }, null, 2)}\n`,
  );

  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.deepEqual(writes(h.fake), []);
  assert.deepEqual((await h.readState('demo'))?.items.AUTH?.baseline, BASELINE);

  // From now on an edit on Taiga is told apart from a manifest change.
  h.fake.editItem(epic, { subject: 'Login' });
  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, EXIT_BLOCKED, plan.stderr);
  assert.deepEqual(plan.json<Plan>().blocked.map((item) => [item.kind, item.key]), [['remote-edit', 'AUTH']]);
});

test('status, assignee, points and tags without a prefix changed on Taiga never block', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        use_case: { as_a: user, i_want_to: log in, so_that: I see my projects }
        scenarios:
          - { scenario: Wrong password, given: [I am on the sign-in page], when: I submit a wrong password, then: I see an error }
        tags: [type:feature]
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
`,
  );
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  const [story] = h.fake.state.userStories;
  const [task] = h.fake.state.tasks;
  const user = h.fake.user.id;
  h.fake.editItem(story!, { status: 2, assigned_to: user, assigned_users: [user], points: { '1': 3 }, tags: [...story!.tags, 'frontend'] });
  h.fake.editItem(task!, { status: 2, assigned_to: user, tags: [...task!.tags, 'backend'] });
  h.fake.editItem(h.fake.state.epics[0]!, { status: 2, assigned_to: user, tags: [...h.fake.state.epics[0]!.tags, 'q3'] });

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(plan.code, 0, plan.stderr);
  const json = plan.json<Plan>();
  assert.deepEqual(json.blocked, []);
  assert.deepEqual(json.summary, { create: 0, update: 0, link: 0, skip: 3 });
});

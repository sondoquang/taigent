import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import type { Plan } from '../src/planner.ts';
import { startHarness } from './support/harness.ts';

const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
    description: Users can sign in.
    tags: [type:feature, area:auth]
  - key: BILLING
    subject: Billing
`;

test('plan lists the epics it would create, as text and as JSON, and exits 3', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(text.code, 3, text.stderr);
  assert.match(text.stdout, /create epic AUTH/);
  assert.match(text.stdout, /create epic BILLING/);

  const json = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(json.code, 3, json.stderr);
  const plan = json.json<Plan>();
  assert.equal(plan.changes, true);
  assert.deepEqual(
    plan.operations.map((op) => [op.action, op.type, op.key]),
    [
      ['create', 'epic', 'AUTH'],
      ['create', 'epic', 'BILLING'],
    ],
  );
  assert.equal(h.fake.state.epics.length, 0, 'plan must not write to Taiga');
});

test('apply without --yes prints the plan, writes nothing and exits 2', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['apply', '--project', 'demo']);

  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /create epic AUTH/);
  assert.match(result.stderr, /--yes/);
  assert.equal(h.fake.state.epics.length, 0);
  assert.equal(await h.readState('demo'), undefined);
});

test('apply --yes creates epics with subject, description and src:<key> tag, and records them in state', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const epics = h.fake.state.epics;
  assert.deepEqual(
    epics.map((e) => ({ project: e.project, subject: e.subject, description: e.description, tags: e.tags })),
    [
      { project: project.id, subject: 'Authentication', description: 'Users can sign in.', tags: ['type:feature', 'area:auth', 'src:auth'] },
      { project: project.id, subject: 'Billing', description: '', tags: ['src:billing'] },
    ],
  );
  const [auth, billing] = epics;
  assert.deepEqual(await h.readState('demo'), {
    project: { id: project.id, slug: 'demo' },
    items: {
      AUTH: { type: 'epic', id: auth!.id, ref: auth!.ref, version: auth!.version },
      BILLING: { type: 'epic', id: billing!.id, ref: billing!.ref, version: billing!.version },
    },
  });
  const report = result.json<ApplyReport>();
  assert.deepEqual(report.summary, { created: 2, updated: 0, linked: 0, unchanged: 0 });
});

test('applying twice creates nothing the second time and plan then reports no changes (exit 0)', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  const second = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /0 created, 0 updated, 0 linked, 2 unchanged/);
  assert.equal(h.fake.state.epics.length, 2);

  const plan = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /No changes/);
  const json = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(json.code, 0);
  assert.equal(json.json<Plan>().changes, false);
});

test('with the state file deleted, apply matches epics by src: tag instead of duplicating them', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  const stateAfterFirstApply = await h.readState('demo');
  await h.deleteState('demo');

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.epics.length, 2);
  assert.deepEqual(await h.readState('demo'), stateAfterFirstApply, 'state is rebuilt from Taiga');
});

test('epics already tagged on Taiga are matched even beyond the first page of results', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const keys = Array.from({ length: 40 }, (_, i) => `E${i + 1}`);
  for (const key of keys) h.fake.addEpic({ project: project.id, subject: key, tags: [`src:${key}`] });
  await h.writeManifest('demo', 'backlog.yaml', `epics:\n${keys.map((k) => `  - { key: ${k}, subject: ${k} }\n`).join('')}`);

  const result = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json<Plan>().summary.skip, 40);
});

test('the manifests root can be moved with TAIGENT_MANIFESTS_DIR', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes'], {
    cwd: tmpdir(),
    env: { TAIGENT_MANIFESTS_DIR: h.manifestsDir },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.epics.length, 2);
  assert.ok(await h.readState('demo'));
});

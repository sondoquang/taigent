import assert from 'node:assert/strict';
import { test } from 'node:test';
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

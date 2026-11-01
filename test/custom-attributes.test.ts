import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import { isRecord } from '../src/guards.ts';
import { startHarness, type Harness } from './support/harness.ts';

const TREE = `epics:
  - key: AUTH
    subject: Authentication
    custom_attributes:
      Client: Acme
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        custom_attributes:
          Due note: before launch
          Billable: true
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            custom_attributes:
              Estimate (h): 4
`;

async function projectWithAttributes(h: Harness) {
  const project = h.fake.addProject({ slug: 'demo' });
  const client = h.fake.addCustomAttribute({ itemType: 'epic', project: project.id, name: 'Client' });
  const due = h.fake.addCustomAttribute({ itemType: 'userstory', project: project.id, name: 'Due note' });
  const billable = h.fake.addCustomAttribute({ itemType: 'userstory', project: project.id, name: 'Billable', type: 'checkbox' });
  const estimate = h.fake.addCustomAttribute({ itemType: 'task', project: project.id, name: 'Estimate (h)', type: 'number' });
  return { project, client, due, billable, estimate };
}

test('apply writes custom attribute values by name on new epics, stories and tasks, sending the version', async (t) => {
  const h = await startHarness(t);
  const { client, due, billable, estimate } = await projectWithAttributes(h);
  await h.writeManifest('demo', 'backlog.yaml', TREE);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const [epic] = h.fake.state.epics;
  const [story] = h.fake.state.userStories;
  const [task] = h.fake.state.tasks;
  const values = (itemType: string, item: number) =>
    h.fake.state.customAttributeValues.find((v) => v.itemType === itemType && v.item === item)?.attributes_values;
  assert.deepEqual(values('epic', epic!.id), { [String(client.id)]: 'Acme' });
  assert.deepEqual(values('userstory', story!.id), { [String(due.id)]: 'before launch', [String(billable.id)]: true });
  assert.deepEqual(values('task', task!.id), { [String(estimate.id)]: 4 });
  const patches = h.fake.requests.filter((r) => r.method === 'PATCH' && r.path.includes('/custom-attributes-values/'));
  assert.deepEqual(
    patches.map((r) => r.path),
    [`/epics/custom-attributes-values/${epic!.id}`, `/userstories/custom-attributes-values/${story!.id}`, `/tasks/custom-attributes-values/${task!.id}`],
  );
  for (const patch of patches) assert.ok(isRecord(patch.body) && patch.body.version === 1, 'PATCH carries the values version');
  assert.deepEqual(result.json<ApplyReport>().summary, { created: 3, updated: 0, linked: 1, unchanged: 0 });
});

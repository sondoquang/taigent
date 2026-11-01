import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import { isRecord } from '../src/guards.ts';
import type { Plan } from '../src/planner.ts';
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

test('re-applying the same values changes nothing: plan exits 0 and apply sends no PATCH', async (t) => {
  const h = await startHarness(t);
  await projectWithAttributes(h);
  await h.writeManifest('demo', 'backlog.yaml', TREE);
  const first = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(first.code, 0, first.stderr);
  const requestsBefore = h.fake.requests.length;

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(plan.json<Plan>().changes, false);

  const again = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json<ApplyReport>().summary, { created: 0, updated: 0, linked: 0, unchanged: 3 });
  assert.deepEqual(
    h.fake.requests.slice(requestsBefore).filter((r) => r.method !== 'GET' && r.path !== '/auth').map((r) => `${r.method} ${r.path}`),
    [],
  );
});

test('plan shows values that differ on Taiga; apply sets them and keeps values the manifest does not declare', async (t) => {
  const h = await startHarness(t);
  const { project, due, billable } = await projectWithAttributes(h);
  const owner = h.fake.addCustomAttribute({ itemType: 'userstory', project: project.id, name: 'Owner' });
  const story = h.fake.addUserStory({ project: project.id, subject: 'User can log in', tags: ['src:auth-login'] });
  h.fake.editAttributeValues('userstory', story.id, { [String(due.id)]: 'next week', [String(owner.id)]: 'alice' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        custom_attributes:
          Due note: before launch
          Billable: true
`,
  );
  h.fake.addEpicRelatedUserStory(h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['src:auth'] }).id, story.id);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const update = plan.json<Plan>().operations.find((op) => op.key === 'AUTH-LOGIN');
  assert.deepEqual(update, {
    action: 'update',
    type: 'story',
    key: 'AUTH-LOGIN',
    id: story.id,
    ref: story.ref,
    version: story.version,
    changes: {
      custom_attributes: { from: { 'Due note': 'next week', Billable: null }, to: { 'Due note': 'before launch', Billable: true }, version: 2 },
    },
  });
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.match(text.stdout, /~ update story AUTH-LOGIN .*custom_attributes.*Due note: "next week" -> "before launch"; Billable: null -> true/);

  const applied = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(applied.json<ApplyReport>().summary, { created: 0, updated: 1, linked: 0, unchanged: 1 });
  const values = h.fake.state.customAttributeValues.find((v) => v.itemType === 'userstory' && v.item === story.id)!;
  assert.deepEqual(values.attributes_values, { [String(due.id)]: 'before launch', [String(owner.id)]: 'alice', [String(billable.id)]: true });
  assert.equal(h.fake.state.userStories[0]!.version, story.version, 'only the values changed: the story itself is not PATCHed');
  assert.equal(h.fake.requests.filter((r) => r.method === 'PATCH' && r.path === `/userstories/${story.id}`).length, 0);
});

test('an attribute name the project does not define fails before any write, naming it (exit 5)', async (t) => {
  const h = await startHarness(t);
  const { project } = await projectWithAttributes(h);
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
    custom_attributes:
      Clientt: Acme
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        custom_attributes:
          Estimate (h): 3
`,
  );

  for (const command of ['plan', 'apply']) {
    const result = await h.taigent([command, '--project', 'demo', '--yes', '--json']);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /AUTH \(epic\): "Clientt"; epic attributes on Taiga: "Client"/);
    assert.match(result.stderr, /AUTH-LOGIN \(story\): "Estimate \(h\)"; userstory attributes on Taiga: "Due note", "Billable"/);
    assert.equal(result.json<{ error: { kind: string } }>().error.kind, 'taiga');
  }
  assert.equal(h.fake.state.epics.filter((e) => e.project === project.id).length, 0);
  assert.equal(h.fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth').length, 0);
});

test('values changed on Taiga between plan and apply are not overwritten (version conflict, exit 5)', async (t) => {
  const h = await startHarness(t);
  const { project, client } = await projectWithAttributes(h);
  const epic = h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['src:auth'] });
  await h.writeManifest('demo', 'backlog.yaml', 'epics:\n  - key: AUTH\n    subject: Authentication\n    custom_attributes:\n      Client: Acme\n');
  h.fake.onRequest({
    method: 'GET',
    path: `/epics/custom-attributes-values/${epic.id}`,
    times: 2,
    run: () => {
      // Second read (by apply, just before its PATCH): someone sets the value meanwhile.
      if (h.fake.requests.filter((r) => r.path === `/epics/custom-attributes-values/${epic.id}`).length === 2) {
        h.fake.editAttributeValues('epic', epic.id, { [String(client.id)]: 'Globex' });
      }
    },
  });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 5, result.stderr);
  assert.deepEqual(result.json<{ error: { kind: string; key: string } }>().error.kind, 'conflict');
  assert.deepEqual(h.fake.state.customAttributeValues.find((v) => v.item === epic.id)!.attributes_values, { [String(client.id)]: 'Globex' });
});

test('custom attribute values must be a mapping of name to string, number or boolean (exit 4, offline)', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    'epics:\n  - key: AUTH\n    subject: Authentication\n    custom_attributes:\n      Client: [a, b]\n  - key: BILL\n    subject: Billing\n    custom_attributes: [x]\n',
  );

  const result = await h.taigent(['validate', '--project', 'demo']);

  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /epics\[0\]\.custom_attributes\.Client: must be a string, number or boolean \[type\]/);
  assert.match(result.stderr, /epics\[1\]\.custom_attributes: must be a mapping of attribute name to value \[type\]/);
});

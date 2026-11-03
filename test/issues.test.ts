// Issue as a backlog item (spec #35, ticket #49): `issues[]` of backlog.yaml through validate, plan and apply.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import type { Plan } from '../src/planner.ts';
import type { FakeIssue, FakeIssueValue, FakeState } from './support/fake-taiga.ts';
import { OFFLINE, startHarness, writes, type Harness } from './support/harness.ts';

interface ErrorOutput {
  error: { kind: string; message: string; issues?: ManifestIssue[] };
}

const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
issues:
  - key: BUG-LONG-PASSWORD
    subject: Login fails with a 100-character password
    description: |
      ## Steps to reproduce
      1. Open the sign-in page
    type: Bug
    severity: Critical
    priority: High
    tags: [type:bug, area:auth]
  - key: ASK-SSO
    subject: Do we support single sign-on?
    type: Question
    severity: Minor
    priority: Low
`;

test('validate accepts issues offline', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.fake.requests, []);
});

test('validate checks the shape of every issue with the backlog rules; issues share the key space', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
issues:
  - key: bug-1
    subject: ''
    type: Bug
    severity: Normal
    priority: High
  - key: AUTH
    subject: Duplicate key
    severity: [Normal]
    priority: ''
    status: New
    tags: [urgent]
    custom_attributes: { Found in: [1] }
  - just a string
`,
  );

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const { error } = result.json<ErrorOutput>();
  assert.equal(error.kind, 'validation');
  assert.deepEqual(
    error.issues?.map((i) => [i.path, i.rule]),
    [
      ['issues[0].key', 'key-format'],
      ['issues[0].subject', 'required'],
      ['issues[1].status', 'known-field'],
      ['issues[1].key', 'key-unique'],
      ['issues[1].tags[0]', 'tag-prefix'],
      ['issues[1].custom_attributes.Found in', 'type'],
      ['issues[1].type', 'required'],
      ['issues[1].severity', 'type'],
      ['issues[1].priority', 'required'],
      ['issues[2]', 'type'],
    ],
  );

  // plan and apply refuse the same manifest before contacting Taiga.
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, 4);
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 4);
  assert.deepEqual(h.fake.requests, []);
});

test('validate rejects an issues value that is not a list', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', 'epics: []\nissues: { key: BUG }\n');

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  assert.deepEqual(result.json<ErrorOutput>().error.issues?.map((i) => [i.path, i.rule]), [['issues', 'type']]);
});

/** Id of the value named `name` in one of the project's issue value lists on the fake. */
function valueId(h: Harness, list: 'issueStatuses' | 'issueTypes' | 'severities' | 'priorities', project: number, name: string): number {
  const value = (h.fake.state[list] as FakeIssueValue[]).find((v) => v.project === project && v.name === name);
  assert.ok(value, `no ${list} value "${name}" in project ${project}`);
  return value.id;
}

function issueByKey(state: FakeState, key: string): FakeIssue {
  const issue = state.issues.find((i) => i.tags.includes(`src:${key.toLowerCase()}`));
  assert.ok(issue, `no issue ${key} on the fake`);
  return issue;
}

async function applyBacklog(h: Harness, backlog: string): Promise<ApplyReport> {
  await h.writeManifest('demo', 'backlog.yaml', backlog);
  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(result.code, 0, result.stderr);
  return result.json<ApplyReport>();
}

test('apply creates each issue tagged src:<key> with the ids of its type, severity and priority; a re-run changes nothing', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const id = (list: Parameters<typeof valueId>[1], name: string) => valueId(h, list, project.id, name);

  const report = await applyBacklog(h, BACKLOG);

  assert.deepEqual(
    h.fake.state.issues.map(({ project, subject, description, tags, type, severity, priority, status, assigned_to, milestone }) => ({
      project, subject, description, tags, type, severity, priority, status, assigned_to, milestone,
    })),
    [
      {
        project: project.id,
        subject: 'Login fails with a 100-character password',
        description: '## Steps to reproduce\n1. Open the sign-in page\n',
        tags: ['type:bug', 'area:auth', 'src:bug-long-password'],
        type: id('issueTypes', 'Bug'),
        severity: id('severities', 'Critical'),
        priority: id('priorities', 'High'),
        status: id('issueStatuses', 'New'),
        assigned_to: null,
        milestone: null,
      },
      {
        project: project.id,
        subject: 'Do we support single sign-on?',
        description: '',
        tags: ['src:ask-sso'],
        type: id('issueTypes', 'Question'),
        severity: id('severities', 'Minor'),
        priority: id('priorities', 'Low'),
        status: id('issueStatuses', 'New'),
        assigned_to: null,
        milestone: null,
      },
    ],
  );
  // Status, assignee and sprint are never sent: Taiga gives a new issue the project's default status.
  for (const request of h.fake.requests.filter((r) => r.method === 'POST' && r.path === '/issues')) {
    assert.deepEqual(Object.keys(request.body as object).sort(), ['description', 'priority', 'project', 'severity', 'subject', 'tags', 'type']);
  }
  assert.deepEqual(
    report.operations.filter((op) => op.type === 'issue').map((op) => [op.action, op.key, op.result]),
    [
      ['create', 'BUG-LONG-PASSWORD', 'created'],
      ['create', 'ASK-SSO', 'created'],
    ],
  );
  const sso = issueByKey(h.fake.state, 'ASK-SSO');
  assert.deepEqual((await h.readState('demo'))!.items['ASK-SSO'], {
    type: 'issue',
    id: sso.id,
    ref: sso.ref,
    version: 1,
    baseline: { subject: 'Do we support single sign-on?', description: '', tags: [], custom_attributes: {}, type: 'Question', severity: 'Minor', priority: 'Low' },
  });

  // The src: tag is the identity: a re-run, even without state.json, plans nothing.
  await h.deleteState('demo');
  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  const { changes, operations, orphans } = plan.json<Plan>();
  assert.equal(changes, false);
  assert.deepEqual(
    operations.filter((op) => op.type === 'issue').map((op) => [op.action, op.key]),
    [
      ['skip', 'BUG-LONG-PASSWORD'],
      ['skip', 'ASK-SSO'],
    ],
  );
  assert.deepEqual(orphans, []);
});

test('editing any managed field of an issue updates it with its version; status and assignee set on Taiga stay', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const id = (list: Parameters<typeof valueId>[1], name: string) => valueId(h, list, project.id, name);
  await applyBacklog(h, BACKLOG);
  const bug = issueByKey(h.fake.state, 'BUG-LONG-PASSWORD');
  const sso = issueByKey(h.fake.state, 'ASK-SSO');
  // People work on the issues on Taiga meanwhile.
  h.fake.editItem(bug, { status: id('issueStatuses', 'In progress'), assigned_to: h.fake.user.id });
  h.fake.editItem(sso, { status: id('issueStatuses', 'Needs Info'), tags: ['src:ask-sso', 'customer'] });

  await h.writeManifest(
    'demo',
    'backlog.yaml',
    BACKLOG.replace('subject: Login fails with a 100-character password', 'subject: Sign-in fails with a 100-character password')
      .replace('1. Open the sign-in page', '1. Open the sign-in page\n      2. Type a 100-character password')
      .replace('type: Question', 'type: Enhancement')
      .replace('severity: Minor', 'severity: Important')
      .replace('priority: Low\n', 'priority: Normal\n    tags: [area:auth]\n'),
  );
  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const updates = plan.json<Plan>().operations.filter((op) => op.action === 'update');
  assert.deepEqual(
    updates.map((op) => [op.key, Object.keys(op.changes)]),
    [
      ['BUG-LONG-PASSWORD', ['subject', 'description']],
      ['ASK-SSO', ['tags', 'type', 'severity', 'priority']],
    ],
  );
  assert.deepEqual(updates[1]!.changes.type, {
    from: id('issueTypes', 'Question'),
    to: id('issueTypes', 'Enhancement'),
    names: { from: 'Question', to: 'Enhancement' },
  });
  // The text form names the values, not their ids.
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.match(text.stdout, /update issue ASK-SSO .*: tags, type \(Question -> Enhancement\), severity \(Minor -> Important\), priority \(Low -> Normal\)/);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    h.fake.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/issues/')).map((r) => [r.path, r.body]),
    [
      [
        `/issues/${bug.id}`,
        {
          subject: 'Sign-in fails with a 100-character password',
          description: '## Steps to reproduce\n1. Open the sign-in page\n2. Type a 100-character password\n',
          version: 2,
        },
      ],
      [
        `/issues/${sso.id}`,
        {
          tags: ['src:ask-sso', 'customer', 'area:auth'],
          type: id('issueTypes', 'Enhancement'),
          severity: id('severities', 'Important'),
          priority: id('priorities', 'Normal'),
          version: 2,
        },
      ],
    ],
  );
  assert.deepEqual(
    { status: bug.status, assigned_to: bug.assigned_to, milestone: bug.milestone },
    { status: id('issueStatuses', 'In progress'), assigned_to: h.fake.user.id, milestone: null },
  );
  assert.equal(sso.status, id('issueStatuses', 'Needs Info'));
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, 0);
});

test('an issue changed on Taiga after plan read it is a version conflict; nothing is overwritten', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await applyBacklog(h, BACKLOG);
  const bug = issueByKey(h.fake.state, 'BUG-LONG-PASSWORD');
  const minor = valueId(h, 'severities', bug.project, 'Minor');
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG.replace('severity: Critical', 'severity: Important'));
  h.fake.onRequest({ method: 'PATCH', path: `/issues/${bug.id}`, run: () => h.fake.editItem(bug, { severity: minor }) });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 5, result.stderr);
  const { error } = result.json<{ error: { kind: string; key: string } }>();
  assert.deepEqual([error.kind, error.key], ['conflict', 'BUG-LONG-PASSWORD']);
  assert.equal(bug.severity, minor);
});

test('a type, severity or priority the project does not define fails plan and apply with issue-value, before any write', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    BACKLOG.replace('type: Bug', 'type: Defect').replace('severity: Minor', 'severity: Blocker').replace('priority: Low', 'priority: low'),
  );

  for (const args of [['plan'], ['apply', '--yes']]) {
    const result = await h.taigent([...args, '--project', 'demo', '--json']);

    assert.equal(result.code, 4, result.stderr);
    const { error } = result.json<ErrorOutput>();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(
      error.issues?.map((i) => [i.file.replaceAll('\\', '/'), i.path, i.rule]),
      [
        ['taiga/demo/backlog.yaml', 'issues[0].type', 'issue-value'],
        ['taiga/demo/backlog.yaml', 'issues[1].severity', 'issue-value'],
        ['taiga/demo/backlog.yaml', 'issues[1].priority', 'issue-value'],
      ],
    );
    assert.match(error.issues![0]!.message, /"Defect".*"Bug", "Question", "Enhancement"/);
  }
  assert.deepEqual(writes(h.fake), []);
});

test('plan lists an issue whose key left the manifest as an orphan; apply never deletes it', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const old = h.fake.addIssue({ project: project.id, subject: 'Old crash', tags: ['src:bug-old'] });
  h.fake.addIssue({ project: project.id, subject: 'Reported by hand' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(result.json<Plan>().orphans, [{ type: 'issue', key: 'BUG-OLD', id: old.id, ref: old.ref, subject: 'Old crash' }]);
  await applyBacklog(h, BACKLOG);
  assert.equal(h.fake.state.issues.length, 4);
  assert.ok(!h.fake.requests.some((r) => r.method === 'DELETE'));
});

test('issue custom attributes: bootstrap creates them from project.yaml and apply sets their values', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'demo-issues',
    'project.yaml',
    `name: Demo - Issues
slug: demo-issues
description: Issue tracking.
template: scrum
modules: [epics, backlog, issues, wiki]
custom_attributes:
  issue:
    - name: Found in
`,
  );
  const bootstrap = await h.taigent(['bootstrap', '--project', 'demo-issues', '--yes']);
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  const attribute = h.fake.state.customAttributes.find((a) => a.itemType === 'issue' && a.name === 'Found in');
  assert.ok(attribute, 'bootstrap did not create the issue attribute');

  await h.writeManifest('demo-issues', 'backlog.yaml', `${BACKLOG}    custom_attributes: { Found in: 1.2.0 }\n`);
  const result = await h.taigent(['apply', '--project', 'demo-issues', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  const sso = issueByKey(h.fake.state, 'ASK-SSO');
  const values = h.fake.state.customAttributeValues.find((v) => v.itemType === 'issue' && v.item === sso.id);
  assert.deepEqual(values?.attributes_values, { [String(attribute.id)]: '1.2.0' });
  assert.equal((await h.taigent(['plan', '--project', 'demo-issues'])).code, 0);
});

test('preview keeps working on a backlog with issues', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['preview', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
});

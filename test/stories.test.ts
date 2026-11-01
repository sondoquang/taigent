import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import { isRecord } from '../src/guards.ts';
import type { Plan } from '../src/planner.ts';
import type { FakeUserStory } from './support/fake-taiga.ts';
import { startHarness, type Harness } from './support/harness.ts';

const TREE = `epics:
  - key: AUTH
    subject: Authentication
    tags: [area:auth]
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        description: As a user I want to log in so that I see my projects.
        acceptance_criteria:
          - Wrong password shows an error
          - Session survives a reload
        spec: docs/specs/auth.md
        tags: [type:feature]
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            description: POST /login returns a session.
          - key: AUTH-LOGIN-UI
            subject: Login form
      - key: AUTH-LOGOUT
        subject: User can log out
`;

test('apply creates stories with the description template and tags, and tasks under their parent story', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', TREE);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  const stories = h.fake.state.userStories;
  assert.deepEqual(
    stories.map((s) => ({ project: s.project, subject: s.subject, description: s.description, tags: s.tags })),
    [
      {
        project: project.id,
        subject: 'User can log in',
        description: [
          'As a user I want to log in so that I see my projects.',
          '',
          '## Acceptance criteria',
          '',
          '- [ ] Wrong password shows an error',
          '- [ ] Session survives a reload',
          '',
          'Spec: docs/specs/auth.md',
        ].join('\n'),
        tags: ['type:feature', 'src:auth-login'],
      },
      { project: project.id, subject: 'User can log out', description: '', tags: ['src:auth-logout'] },
    ],
  );
  const [login] = stories;
  assert.deepEqual(
    h.fake.state.tasks.map((task) => ({ project: task.project, user_story: task.user_story, subject: task.subject, description: task.description, tags: task.tags })),
    [
      { project: project.id, user_story: login!.id, subject: 'Login endpoint', description: 'POST /login returns a session.', tags: ['src:auth-login-api'] },
      { project: project.id, user_story: login!.id, subject: 'Login form', description: '', tags: ['src:auth-login-ui'] },
    ],
  );
  const state = await h.readState('demo');
  assert.deepEqual(
    Object.entries(state!.items).map(([key, entry]) => [key, entry.type]),
    [
      ['AUTH', 'epic'],
      ['AUTH-LOGIN', 'story'],
      ['AUTH-LOGIN-API', 'task'],
      ['AUTH-LOGIN-UI', 'task'],
      ['AUTH-LOGOUT', 'story'],
    ],
  );
  assert.equal(state!.items['AUTH-LOGIN-API']!.id, h.fake.state.tasks[0]!.id);
});

async function applyTree(h: Harness, manifest = TREE): Promise<void> {
  await h.writeManifest('demo', 'backlog.yaml', manifest);
  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(result.code, 0, result.stderr);
}

function storyBySubject(h: Harness, subject: string): FakeUserStory {
  const story = h.fake.state.userStories.find((s) => s.subject === subject);
  assert.ok(story, `no story "${subject}" on the fake`);
  return story;
}

test('apply links each story to its epic through related_userstories', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });

  await applyTree(h);

  const [auth] = h.fake.state.epics;
  assert.deepEqual(
    h.fake.state.epicRelatedUserStories.map((link) => [link.epic, link.user_story]),
    [
      [auth!.id, storyBySubject(h, 'User can log in').id],
      [auth!.id, storyBySubject(h, 'User can log out').id],
    ],
  );
});

test('a link that already exists on Taiga is checked with GET first and not posted again', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['area:auth', 'src:auth'] });
  const story = h.fake.addUserStory({ project: project.id, subject: 'User can log out', tags: ['src:auth-logout'] });
  h.fake.addEpicRelatedUserStory(epic.id, story.id);
  const manifest = `epics:
  - key: AUTH
    subject: Authentication
    tags: [area:auth]
    stories:
      - { key: AUTH-LOGOUT, subject: User can log out }
`;
  await h.writeManifest('demo', 'backlog.yaml', manifest);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.deepEqual(plan.json<Plan>().summary, { create: 0, update: 0, link: 0, skip: 2 });

  await applyTree(h, manifest);
  assert.ok(h.fake.requests.some((r) => r.method === 'GET' && r.path === `/epics/${epic.id}/related_userstories`));
  assert.ok(!h.fake.requests.some((r) => r.method === 'POST' && r.path.endsWith('/related_userstories')));
  assert.equal(h.fake.state.epicRelatedUserStories.length, 1);
});

test('changed subject, description and tags are updated with the current version, keeping tags added on Taiga', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await applyTree(h);
  const login = storyBySubject(h, 'User can log in');
  h.fake.editItem(login, { tags: [...login.tags, 'needs-design'] });
  const versionBefore = login.version;
  const task = h.fake.state.tasks.find((x) => x.subject === 'Login endpoint')!;

  const changed = TREE.replace('subject: User can log in', 'subject: User can sign in')
    .replace('- Session survives a reload', '- Session survives a browser restart')
    .replace('tags: [type:feature]', 'tags: [type:feature, area:auth]')
    .replace('description: POST /login returns a session.', 'description: POST /sessions returns a session.');
  await h.writeManifest('demo', 'backlog.yaml', changed);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const updates = plan.json<Plan>().operations.filter((op) => op.action === 'update');
  assert.deepEqual(
    updates.map((op) => [op.type, op.key, Object.keys(op.changes)]),
    [
      ['story', 'AUTH-LOGIN', ['subject', 'description', 'tags']],
      ['task', 'AUTH-LOGIN-API', ['description']],
    ],
  );
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.match(text.stdout, /update story AUTH-LOGIN .*subject, description, tags/);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(login.subject, 'User can sign in');
  assert.match(login.description, /- \[ \] Session survives a browser restart/);
  assert.deepEqual(login.tags, ['type:feature', 'src:auth-login', 'needs-design', 'area:auth']);
  assert.equal(task.description, 'POST /sessions returns a session.');
  const patch = h.fake.requests.find((r) => r.method === 'PATCH' && r.path === `/userstories/${login.id}`);
  assert.ok(isRecord(patch?.body));
  assert.equal(patch.body.version, versionBefore, 'the PATCH carries the version read from Taiga');
  assert.deepEqual(result.json<ApplyReport>().summary, { created: 0, updated: 2, linked: 0, unchanged: 3 });
  assert.equal((await h.readState('demo'))!.items['AUTH-LOGIN']!.version, login.version);
  assert.equal(h.fake.state.userStories.length, 2, 'updates never create items');
});

test('a version conflict names the key, exits 5 and does not overwrite the concurrent edit', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await applyTree(h);
  const login = storyBySubject(h, 'User can log in');
  await h.writeManifest('demo', 'backlog.yaml', TREE.replace('subject: User can log in', 'subject: User can sign in'));
  // Someone edits the same field on Taiga between our read and our PATCH.
  h.fake.onRequest({ method: 'PATCH', path: `/userstories/${login.id}`, run: () => h.fake.editItem(login, { subject: 'Edited on Taiga' }) });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /AUTH-LOGIN/);
  assert.match(result.stderr, /conflict/);
  const { error } = result.json<{ error: { kind: string; key: string } }>();
  assert.equal(error.kind, 'conflict');
  assert.equal(error.key, 'AUTH-LOGIN');
  assert.equal(login.subject, 'Edited on Taiga');
});

test('status, assignee, sprint and points changed on Taiga are never overwritten by apply', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await applyTree(h);
  const login = storyBySubject(h, 'User can log in');
  const task = h.fake.state.tasks[0]!;
  h.fake.editItem(login, { status: 3, assigned_to: h.fake.user.id, milestone: 77, points: { '1': 5 } });
  h.fake.editItem(task, { status: 9, assigned_to: h.fake.user.id });
  await h.writeManifest('demo', 'backlog.yaml', TREE.replace('Session survives a reload', 'Session survives a restart').replace('subject: Login endpoint', 'subject: Session endpoint'));
  // A concurrent edit of a field apply does not manage is merged by Taiga, not a conflict.
  h.fake.onRequest({ method: 'PATCH', path: `/userstories/${login.id}`, run: () => h.fake.editItem(login, { status: 4 }) });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(login.description, /Session survives a restart/);
  assert.equal(task.subject, 'Session endpoint');
  assert.deepEqual(
    { status: login.status, assigned_to: login.assigned_to, milestone: login.milestone, points: login.points },
    { status: 4, assigned_to: h.fake.user.id, milestone: 77, points: { '1': 5 } },
  );
  assert.deepEqual({ status: task.status, assigned_to: task.assigned_to, user_story: task.user_story }, { status: 9, assigned_to: h.fake.user.id, user_story: login.id });
});

test('items tagged src: on Taiga but gone from the manifest are reported as orphans and never deleted', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  await applyTree(h);
  h.fake.addEpic({ project: project.id, subject: 'Legacy', tags: ['src:legacy'] });
  h.fake.addUserStory({ project: project.id, subject: 'Hand-made story', tags: ['needs-design'] });
  const withoutLogoutAndUi = TREE.replace(/ {6}- key: AUTH-LOGOUT\n.*\n/, '').replace(/ {10}- key: AUTH-LOGIN-UI\n.*\n/, '');
  await h.writeManifest('demo', 'backlog.yaml', withoutLogoutAndUi);

  const json = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(json.code, 0, json.stderr);
  const plan = json.json<Plan>();
  assert.equal(plan.changes, false);
  assert.deepEqual(
    plan.orphans.map((o) => [o.type, o.key, o.subject]),
    [
      ['epic', 'LEGACY', 'Legacy'],
      ['story', 'AUTH-LOGOUT', 'User can log out'],
      ['task', 'AUTH-LOGIN-UI', 'Login form'],
    ],
  );
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.match(text.stdout, /orphan story AUTH-LOGOUT/);
  assert.match(text.stdout, /never deleted/);

  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(h.fake.state.epics.length, 2);
  assert.equal(h.fake.state.userStories.length, 3);
  assert.equal(h.fake.state.tasks.length, 2);
  assert.ok(!h.fake.requests.some((r) => r.method === 'DELETE'));
});

test('re-applying the full tree, even without the state file, creates no duplicate story, task or link', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await applyTree(h);
  const stateAfterFirstApply = await h.readState('demo');

  const second = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(second.json<ApplyReport>().summary, { created: 0, updated: 0, linked: 0, unchanged: 5 });
  await h.deleteState('demo');
  await applyTree(h);

  assert.equal(h.fake.state.epics.length, 1);
  assert.equal(h.fake.state.userStories.length, 2);
  assert.equal(h.fake.state.tasks.length, 2);
  assert.equal(h.fake.state.epicRelatedUserStories.length, 2);
  assert.deepEqual(await h.readState('demo'), stateAfterFirstApply);
  const plan = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /No changes/);
});

test('the backlog tree is validated: unknown story fields, bad criteria and keys shared across levels exit 4', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH
        subject: Same key as the epic
        status: Done
        acceptance_criteria: just one string
        tasks:
          - { key: AUTH-T1 }
`);

  const result = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(result.code, 4, result.stderr);
  const { error } = result.json<{ error: { issues: { path: string; rule: string }[] } }>();
  assert.deepEqual(
    error.issues.map((i) => [i.path, i.rule]),
    [
      ['epics[0].stories[0].status', 'known-field'],
      ['epics[0].stories[0].key', 'key-unique'],
      ['epics[0].stories[0].acceptance_criteria', 'type'],
      ['epics[0].stories[0].tasks[0].subject', 'required'],
    ],
  );
  assert.equal(h.fake.requests.length, 0, 'Taiga is not contacted');
});

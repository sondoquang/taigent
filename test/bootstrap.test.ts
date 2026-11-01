import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BootstrapPlan, BootstrapReport } from '../src/bootstrap.ts';
import type { FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, type Harness } from './support/harness.ts';

const SLUG = 'acme-portal';

const PROJECT_YAML = `name: Acme - Portal
slug: acme-portal
description: Customer self-service portal.
template: scrum
is_private: true
modules: [epics, wiki, kanban]
tags:
  - name: type:feature
  - name: area:billing
    color: "#1565C0"
custom_attributes:
  epic:
    - name: Spec link
      type: url
  story:
    - name: Acceptance owner
  task:
    - name: Estimate (h)
      type: number
      description: Hours of work
members:
  - username: alice
    role: Back
  - email: bob@example.test
    role: Front
  - email: carol@newcomer.test
    role: UX
wiki_home: |
  # Acme Portal
  Start here.
`;

async function setup(t: Parameters<typeof startHarness>[0], yaml = PROJECT_YAML): Promise<Harness> {
  const h = await startHarness(t);
  h.fake.addUser({ username: 'alice', email: 'alice@example.test' });
  h.fake.addUser({ username: 'bob', email: 'bob@example.test' });
  await h.writeManifest(SLUG, 'project.yaml', yaml);
  return h;
}

/** Requests that change Taiga (everything except reads and login). */
function writes(fake: FakeTaiga): string[] {
  return fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth').map((r) => `${r.method} ${r.path}`);
}

function projectAttributes(fake: FakeTaiga, projectId: number) {
  return fake.state.customAttributes
    .filter((a) => a.project === projectId)
    .map((a) => ({ itemType: a.itemType, name: a.name, type: a.type, description: a.description }));
}

function projectMembers(fake: FakeTaiga, projectId: number) {
  return fake.state.memberships
    .filter((m) => m.project === projectId)
    .map((m) => ({
      who: fake.state.users.find((u) => u.id === m.user)?.username ?? m.email,
      role: fake.state.roles.find((r) => r.id === m.role)!.name,
    }));
}

test('bootstrap --yes creates the project from the template looked up by name and configures it', async (t) => {
  const h = await setup(t);

  const result = await h.taigent(['bootstrap', '--project', SLUG, '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const project = h.fake.state.projects.find((p) => p.slug === SLUG);
  assert.ok(project, 'project created with the manifest slug');

  const create = h.fake.requests.find((r) => r.method === 'POST' && r.path === '/projects');
  assert.deepEqual(create?.body, {
    name: 'Acme - Portal',
    description: 'Customer self-service portal.',
    creation_template: 1,
    is_private: true,
  });
  assert.ok(h.fake.requests.some((r) => r.method === 'GET' && r.path === '/project-templates'));

  const patch = h.fake.requests.find((r) => r.method === 'PATCH' && r.path === `/projects/${project.id}`);
  assert.deepEqual(patch?.body, { is_epics_activated: true, is_kanban_activated: true });
  assert.equal(project.modules.is_epics_activated, true);

  assert.deepEqual(project.tagsColors, { 'type:feature': '#2E7D32', 'area:billing': '#1565C0' });
  assert.deepEqual(projectAttributes(h.fake, project.id), [
    { itemType: 'epic', name: 'Spec link', type: 'url', description: '' },
    { itemType: 'userstory', name: 'Acceptance owner', type: 'text', description: '' },
    { itemType: 'task', name: 'Estimate (h)', type: 'number', description: 'Hours of work' },
  ]);
  assert.deepEqual(projectMembers(h.fake, project.id), [
    { who: 'taigent-bot', role: 'Product Owner' },
    { who: 'alice', role: 'Back' },
    { who: 'bob', role: 'Front' },
    { who: 'carol@newcomer.test', role: 'UX' },
  ]);
  assert.deepEqual(
    h.fake.state.wikiPages.map((p) => ({ project: p.project, slug: p.slug, content: p.content })),
    [{ project: project.id, slug: 'home', content: '# Acme Portal\nStart here.\n' }],
  );

  assert.deepEqual(await h.readState(SLUG), { project: { id: project.id, slug: SLUG }, items: {} });
  const report = result.json<BootstrapReport>();
  assert.deepEqual(report.project, { id: project.id, slug: SLUG });
  assert.deepEqual(report.summary, { created: 10, updated: 1, unchanged: 0 });
});

test('bootstrap --dry-run lists the operations, writes nothing and exits 3', async (t) => {
  const h = await setup(t);

  const text = await h.taigent(['bootstrap', '--project', SLUG, '--dry-run']);
  assert.equal(text.code, 3, text.stderr);
  assert.match(text.stdout, /create project "Acme - Portal"/);
  assert.match(text.stdout, /template scrum/);
  assert.match(text.stdout, /enable modules epics, kanban/);
  assert.match(text.stdout, /create tag type:feature +#2E7D32/);
  assert.match(text.stdout, /create story custom attribute "Acceptance owner"/);
  assert.match(text.stdout, /invite carol@newcomer\.test as UX/);
  assert.match(text.stdout, /create wiki page home/);

  const json = await h.taigent(['bootstrap', '--project', SLUG, '--dry-run', '--yes', '--json']);
  assert.equal(json.code, 3, json.stderr);
  const plan = json.json<BootstrapPlan>();
  assert.equal(plan.changes, true);
  assert.deepEqual(plan.project, { id: null, slug: SLUG, name: 'Acme - Portal', exists: false });
  assert.deepEqual(plan.operations[0], {
    action: 'create',
    type: 'project',
    template: 'scrum',
    fields: { name: 'Acme - Portal', description: 'Customer self-service portal.', creation_template: 1, is_private: true },
  });
  assert.deepEqual(plan.operations.map((op) => `${op.action} ${op.type}`), [
    'create project',
    'update modules',
    'create tag',
    'create tag',
    'create custom-attribute',
    'create custom-attribute',
    'create custom-attribute',
    'create membership',
    'create membership',
    'create membership',
    'create wiki',
  ]);

  assert.deepEqual(writes(h.fake), [], 'dry-run must not write to Taiga');
  assert.equal(h.fake.state.projects.length, 0);
  assert.equal(await h.readState(SLUG), undefined, 'dry-run must not write state.json');
});

test('bootstrap without --yes or --dry-run prints the plan, writes nothing and exits 2', async (t) => {
  const h = await setup(t);

  const result = await h.taigent(['bootstrap', '--project', SLUG]);

  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /create project/);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(writes(h.fake), []);
});

test('re-running bootstrap on the bootstrapped project creates nothing and reports no changes', async (t) => {
  const h = await setup(t);
  assert.equal((await h.taigent(['bootstrap', '--project', SLUG, '--yes'])).code, 0);
  const before = h.fake.requests.length;

  const again = await h.taigent(['bootstrap', '--project', SLUG, '--yes', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(writes({ ...h.fake, requests: h.fake.requests.slice(before) }), []);
  assert.equal(h.fake.state.projects.length, 1);
  assert.deepEqual(again.json<BootstrapReport>().summary, { created: 0, updated: 0, unchanged: 11 });

  const dry = await h.taigent(['bootstrap', '--project', SLUG, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /No changes/);
});

test('bootstrap on an existing project (matched by slug) only fills the gaps', async (t) => {
  const h = await setup(t);
  const bot = h.fake.user.id;
  const project = h.fake.addProject({
    slug: SLUG,
    name: 'Acme - Portal',
    members: [bot],
    modules: { is_epics_activated: false, is_kanban_activated: true, is_wiki_activated: true },
    tagsColors: { 'area:billing': '#1565C0' },
  });
  // A tag already used by an item but without color: Taiga refuses create_tag for it, so it gets edit_tag.
  h.fake.addEpic({ project: project.id, subject: 'Existing', tags: ['type:feature'] });
  h.fake.addCustomAttribute({ itemType: 'epic', project: project.id, name: 'Spec link', type: 'url' });
  const alice = h.fake.state.users.find((u) => u.username === 'alice')!;
  h.fake.addMembership({ project: project.id, role: 'Design', user: alice.id });
  h.fake.addWikiPage({ project: project.id, slug: 'home', content: 'Hand-written home.' });

  const result = await h.taigent(['bootstrap', '--project', SLUG, '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.projects.length, 1, 'no duplicate project');
  assert.equal(project.modules.is_epics_activated, true);
  assert.deepEqual(project.tagsColors, { 'area:billing': '#1565C0', 'type:feature': '#2E7D32' });
  assert.deepEqual(projectAttributes(h.fake, project.id), [
    { itemType: 'epic', name: 'Spec link', type: 'url', description: '' },
    { itemType: 'userstory', name: 'Acceptance owner', type: 'text', description: '' },
    { itemType: 'task', name: 'Estimate (h)', type: 'number', description: 'Hours of work' },
  ], 'the existing epic attribute is kept, the missing ones are added');
  assert.deepEqual(h.fake.requests.find((r) => r.method === 'PATCH')?.body, { is_epics_activated: true });
  assert.deepEqual(h.fake.requests.find((r) => r.path.endsWith('/edit_tag'))?.body, { from_tag: 'type:feature', color: '#2E7D32' });
  assert.equal(h.fake.state.wikiPages[0]!.content, 'Hand-written home.', 'existing wiki home is left alone');
  assert.deepEqual(projectMembers(h.fake, project.id), [
    { who: 'taigent-bot', role: 'Product Owner' },
    { who: 'alice', role: 'Design' },
    { who: 'bob', role: 'Front' },
    { who: 'carol@newcomer.test', role: 'UX' },
  ]);
  const report = result.json<BootstrapReport>();
  assert.deepEqual(report.summary, { created: 4, updated: 2, unchanged: 5 });
  assert.deepEqual(await h.readState(SLUG), { project: { id: project.id, slug: SLUG }, items: {} });
});

test('bootstrap refuses an existing slug whose project the user does not administer', async (t) => {
  const h = await setup(t);
  h.fake.addProject({ slug: SLUG, name: 'Acme - Portal', members: [h.fake.user.id], admins: [] });

  for (const args of [['--yes'], ['--dry-run']]) {
    const result = await h.taigent(['bootstrap', '--project', SLUG, ...args, '--json']);
    assert.equal(result.code, 5, result.stderr);
    assert.match(result.stderr, /project "acme-portal" already exists.*not an admin/);
    assert.equal(result.json<{ error: { kind: string; status: number } }>().error.status, 403);
  }
  assert.deepEqual(writes(h.fake), []);
});

test('bootstrap rejects a member role that the template does not define before writing anything', async (t) => {
  const h = await setup(t, PROJECT_YAML.replace('role: UX', 'role: Tester'));

  const result = await h.taigent(['bootstrap', '--project', SLUG, '--yes']);

  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /role "Tester" \(member carol@newcomer\.test\) does not exist in template scrum; roles: Product Owner, UX, Design, Front, Back, Stakeholder/);
  assert.deepEqual(writes(h.fake), []);
});

test('bootstrap fails clearly when Taiga assigns another slug, records it, and never creates a duplicate', async (t) => {
  const h = await setup(t);
  h.fake.settings.projectSlugPrefix = true; // the instance prefixes slugs with the owner's username

  const first = await h.taigent(['bootstrap', '--project', SLUG, '--yes']);

  assert.equal(first.code, 5, first.stderr);
  assert.match(first.stderr, /Taiga created the project with slug "taigent-bot-acme-portal" instead of "acme-portal"/);
  const created = h.fake.state.projects[0]!;
  assert.deepEqual((await h.readState(SLUG))?.project, { id: created.id, slug: 'taigent-bot-acme-portal' });

  const again = await h.taigent(['bootstrap', '--project', SLUG, '--yes']);
  assert.equal(again.code, 5, again.stderr);
  assert.match(again.stderr, /state\.json already points to project id \d+ \(slug "taigent-bot-acme-portal"\)/);
  assert.equal(h.fake.state.projects.length, 1, 'no second project');
});

test('bootstrap with an invalid project manifest exits 4 without contacting Taiga', async (t) => {
  const h = await setup(t, PROJECT_YAML.replace('name: Acme - Portal', 'name: Acme Portal').replace('modules: [epics, wiki, kanban]', 'modules: [kanban]'));

  const result = await h.taigent(['bootstrap', '--project', SLUG, '--yes', '--json']);

  assert.equal(result.code, 4, result.stderr);
  const rules = result.json<{ error: { issues: { path: string; rule: string }[] } }>().error.issues.map((i) => `${i.path} ${i.rule}`);
  assert.ok(rules.includes('name project-name'), rules.join('\n'));
  assert.ok(rules.includes('modules module-required'), rules.join('\n'));
  assert.equal(h.fake.requests.length, 0);
});

test('bootstrap requires project.yaml', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(SLUG, 'backlog.yaml', 'epics: []\n');

  const result = await h.taigent(['bootstrap', '--project', SLUG, '--yes']);

  assert.equal(result.code, 4, result.stderr);
  assert.match(result.stderr, /project\.yaml.*manifest file not found/);
});

test('apply --dry-run behaves like plan: lists changes, writes nothing, exits 3', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', 'epics:\n  - key: AUTH\n    subject: Auth\n');

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--dry-run']);

  assert.equal(result.code, 3, result.stderr);
  assert.match(result.stdout, /create epic AUTH/);
  assert.equal(h.fake.state.epics.length, 0);
  assert.equal(await h.readState('demo'), undefined);
});

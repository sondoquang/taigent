import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, type Harness } from './support/harness.ts';

const SLUG = 'demo';

/** Writes a file below `taiga/<slug>/` (text or binary). */
async function writeProjectFile(h: Harness, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(h.manifestsDir, SLUG, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/** Requests that change Taiga (everything except reads and login). */
function writes(fake: FakeTaiga): string[] {
  return fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth').map((r) => `${r.method} ${r.path}`);
}

test('upload --yes creates a wiki page per docs.yaml entry; a re-run creates no duplicate', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: SLUG });
  await writeProjectFile(h, 'pages/spec-auth.md', '# Auth spec\n\nUsers sign in.\n');
  await h.writeManifest(SLUG, 'docs.yaml', 'wiki:\n  - slug: spec-auth\n    file: pages/spec-auth.md\n');

  const first = await h.taigent(['upload', '--project', SLUG, '--yes']);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(
    h.fake.state.wikiPages.map(({ project, slug, content }) => ({ project, slug, content })),
    [{ project: project.id, slug: 'spec-auth', content: '# Auth spec\n\nUsers sign in.\n' }],
  );

  const before = writes(h.fake).length;
  const second = await h.taigent(['upload', '--project', SLUG, '--yes']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(h.fake.state.wikiPages.length, 1);
  assert.deepEqual(writes(h.fake).slice(before), [], 're-run writes nothing');
  assert.ok(h.fake.requests.some((r) => r.method === 'GET' && r.path === '/wiki/by_slug' && r.query.get('slug') === 'spec-auth'));
});

test('upload --yes updates a wiki page whose content differs, sending its version', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: SLUG });
  const page = h.fake.addWikiPage({ project: project.id, slug: 'spec-auth', content: 'old text' });
  await writeProjectFile(h, 'pages/spec-auth.md', '# Auth spec v2\n');
  await h.writeManifest(SLUG, 'docs.yaml', 'wiki:\n  - slug: spec-auth\n    file: pages/spec-auth.md\n');

  const result = await h.taigent(['upload', '--project', SLUG, '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const patch = h.fake.requests.find((r) => r.method === 'PATCH' && r.path === `/wiki/${page.id}`);
  assert.deepEqual(patch?.body, { content: '# Auth spec v2\n', version: 1 });
  assert.equal(h.fake.state.wikiPages.length, 1);
  assert.equal(page.content, '# Auth spec v2\n');
  assert.equal(page.version, 2);
  const report = result.json<{ operations: { type: string; action: string; slug: string; id: number; result: string }[] }>();
  assert.deepEqual(
    report.operations.map(({ type, action, slug, id, result }) => ({ type, action, slug, id, result })),
    [{ type: 'wiki', action: 'update', slug: 'spec-auth', id: page.id, result: 'updated' }],
  );
});

test('upload --yes stops with a conflict when the wiki page changed on Taiga after it was read', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: SLUG });
  const page = h.fake.addWikiPage({ project: project.id, slug: 'spec-auth', content: 'old text' });
  await writeProjectFile(h, 'pages/spec-auth.md', '# Mine\n');
  await h.writeManifest(SLUG, 'docs.yaml', 'wiki:\n  - slug: spec-auth\n    file: pages/spec-auth.md\n');
  h.fake.onRequest({ method: 'PATCH', path: `/wiki/${page.id}`, run: () => h.fake.editWikiPage(page, { content: 'edited by a person' }) });

  const result = await h.taigent(['upload', '--project', SLUG, '--yes', '--json']);

  assert.equal(result.code, 5, result.stderr);
  assert.equal(page.content, 'edited by a person', 'nothing overwritten');
  const { error } = result.json<{ error: { kind: string; key: string } }>();
  assert.equal(error.kind, 'conflict');
  assert.equal(error.key, 'wiki:spec-auth');
});

const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
`;

/** A project whose backlog was applied: one epic, story and task tagged src:<key>. */
async function appliedProject(h: Harness) {
  const project = h.fake.addProject({ slug: SLUG });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['src:auth'] });
  const story = h.fake.addUserStory({ project: project.id, subject: 'User can log in', tags: ['src:auth-login'] });
  const task = h.fake.addTask({ project: project.id, user_story: story.id, subject: 'Login endpoint', tags: ['src:auth-login-api'] });
  await h.writeManifest(SLUG, 'backlog.yaml', BACKLOG);
  return { project, epic, story, task };
}

/** Binary bytes (NUL, 0xFF, CR/LF) so any text decoding of the upload would corrupt them. */
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x01, 0x02]);

test('upload --yes attaches files to an epic, a story, a task and a wiki page as multipart', async (t) => {
  const h = await startHarness(t);
  const { project, epic, story, task } = await appliedProject(h);
  await writeProjectFile(h, 'pages/spec-auth.md', '# Auth\n');
  await writeProjectFile(h, 'files/auth-overview.pdf', PDF);
  await writeProjectFile(h, 'files/login-flow.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  await writeProjectFile(h, 'files/api-contract.json', '{"login": true}\n');
  await writeProjectFile(h, 'files/glossary.txt', 'terms\n');
  await h.writeManifest(
    SLUG,
    'docs.yaml',
    `wiki:
  - slug: spec-auth
    file: pages/spec-auth.md
attachments:
  - target: AUTH
    file: files/auth-overview.pdf
    description: Overview
  - target: AUTH-LOGIN
    file: files/login-flow.png
  - target: AUTH-LOGIN-API
    file: files/api-contract.json
  - target: wiki:spec-auth
    file: files/glossary.txt
`,
  );

  const result = await h.taigent(['upload', '--project', SLUG, '--yes']);

  assert.equal(result.code, 0, result.stderr);
  const page = h.fake.state.wikiPages.find((p) => p.slug === 'spec-auth')!;
  assert.deepEqual(
    h.fake.state.attachments.map((a) => ({ type: a.objectType, object_id: a.object_id, project: a.project, name: a.name, description: a.description, content: a.content })),
    [
      { type: 'epics', object_id: epic.id, project: project.id, name: 'auth-overview.pdf', description: 'Overview', content: PDF },
      { type: 'userstories', object_id: story.id, project: project.id, name: 'login-flow.png', description: '', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) },
      { type: 'tasks', object_id: task.id, project: project.id, name: 'api-contract.json', description: '', content: Buffer.from('{"login": true}\n') },
      { type: 'wiki', object_id: page.id, project: project.id, name: 'glossary.txt', description: '', content: Buffer.from('terms\n') },
    ],
  );
  const upload = h.fake.requests.find((r) => r.method === 'POST' && r.path === '/epics/attachments')!;
  assert.match(String(upload.headers['content-type']), /^multipart\/form-data; boundary=/);
});

interface PlanJson {
  project: { id: number; slug: string };
  changes: boolean;
  summary: { create: number; update: number; skip: number };
  operations: Record<string, unknown>[];
}

const STORY_DOCS = `attachments:
  - target: AUTH-LOGIN
    file: files/login-flow.pdf
    description: Login flow
`;

test('an attachment with the same name, size and sha1 is skipped; a changed file is uploaded and the old one is reported as kept', async (t) => {
  const h = await startHarness(t);
  const { project, story } = await appliedProject(h);
  const old = h.fake.addAttachment({ project: project.id, objectType: 'userstories', object_id: story.id, name: 'login-flow.pdf', content: PDF });
  await writeProjectFile(h, 'files/login-flow.pdf', PDF);
  await h.writeManifest(SLUG, 'docs.yaml', STORY_DOCS);

  const same = await h.taigent(['upload', '--project', SLUG, '--yes']);
  assert.equal(same.code, 0, same.stderr);
  assert.equal(h.fake.state.attachments.length, 1, 'identical file not uploaded again');
  assert.deepEqual(writes(h.fake), []);

  const changed = Buffer.concat([PDF, Buffer.from('v2')]);
  await writeProjectFile(h, 'files/login-flow.pdf', changed);
  const plan = await h.taigent(['upload', '--project', SLUG, '--dry-run', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  assert.deepEqual(plan.json<PlanJson>().operations, [
    {
      action: 'create',
      type: 'attachment',
      previous: [{ id: old.id, size: 12, sha1: '3d4f1cce0b0e7426f1ef01d5c5ee2eacc9626d3c' }],
      target: 'AUTH-LOGIN',
      targetType: 'story',
      objectId: story.id,
      name: 'login-flow.pdf',
      file: join('taiga', SLUG, 'files', 'login-flow.pdf'),
      size: 14,
      sha1: '63e24c9ea6a9938003f616d6970843e37f695db5', // sha1sum of the changed bytes
      description: 'Login flow',
    },
  ]);

  const upload = await h.taigent(['upload', '--project', SLUG, '--yes']);
  assert.equal(upload.code, 0, upload.stderr);
  assert.match(upload.stdout, new RegExp(`login-flow\\.pdf -> story AUTH-LOGIN .*previous attachment \\(id ${old.id}\\) stays on Taiga`));
  const [kept, added] = h.fake.state.attachments;
  assert.equal(h.fake.state.attachments.length, 2);
  assert.deepEqual({ id: kept!.id, content: kept!.content }, { id: old.id, content: PDF }, 'the old attachment stays');
  assert.deepEqual(
    { name: added!.name, objectType: added!.objectType, object_id: added!.object_id, content: added!.content },
    { name: 'login-flow.pdf', objectType: 'userstories', object_id: story.id, content: changed },
    'the new version is added to the same story',
  );

  const rerun = await h.taigent(['upload', '--project', SLUG, '--dry-run']);
  assert.equal(rerun.code, 0, rerun.stdout);
  assert.match(rerun.stdout, /No changes/);
});

test('a file over the server limit (HTTP 413) fails with an error naming the file', async (t) => {
  const h = await startHarness(t);
  await appliedProject(h);
  await writeProjectFile(h, 'files/login-flow.pdf', Buffer.alloc(64 * 1024, 7));
  await h.writeManifest(SLUG, 'docs.yaml', STORY_DOCS);
  h.fake.settings.maxBodyBytes = 16 * 1024;

  const text = await h.taigent(['upload', '--project', SLUG, '--yes']);
  assert.equal(text.code, 5);
  const file = join('taiga', SLUG, 'files', 'login-flow.pdf');
  assert.ok(text.stderr.includes(`taigent: ${file} (65536 bytes) is too large for the Taiga server (HTTP 413`), text.stderr);
  assert.doesNotMatch(text.stderr, /<html>/, 'no proxy HTML in the message');

  const json = await h.taigent(['upload', '--project', SLUG, '--yes', '--json']);
  assert.equal(json.code, 5);
  const { error } = json.json<{ error: { kind: string; status: number; file: string } }>();
  assert.deepEqual({ kind: error.kind, status: error.status, file: error.file }, { kind: 'taiga', status: 413, file });
  assert.equal(h.fake.state.attachments.length, 0);
});

test('upload --dry-run --json lists the operations and writes nothing; without --yes it refuses (exit 2)', async (t) => {
  const h = await startHarness(t);
  const { project, epic } = await appliedProject(h);
  await writeProjectFile(h, 'pages/spec-auth.md', '# Auth\n');
  await writeProjectFile(h, 'files/auth-overview.pdf', PDF);
  await h.writeManifest(
    SLUG,
    'docs.yaml',
    'wiki:\n  - slug: spec-auth\n    file: pages/spec-auth.md\nattachments:\n  - target: wiki:spec-auth\n    file: files/auth-overview.pdf\n  - target: AUTH\n    file: files/auth-overview.pdf\n',
  );

  const dry = await h.taigent(['upload', '--project', SLUG, '--dry-run', '--json']);

  assert.equal(dry.code, 3, dry.stderr);
  const file = join('taiga', SLUG, 'files', 'auth-overview.pdf');
  const common = { name: 'auth-overview.pdf', file, size: 12, sha1: '3d4f1cce0b0e7426f1ef01d5c5ee2eacc9626d3c', description: '', previous: [] };
  assert.deepEqual(dry.json<PlanJson>(), {
    project: { id: project.id, slug: SLUG },
    changes: true,
    summary: { create: 3, update: 0, skip: 0 },
    operations: [
      { action: 'create', type: 'wiki', slug: 'spec-auth', file: join('taiga', SLUG, 'pages', 'spec-auth.md') },
      { action: 'create', type: 'attachment', target: 'wiki:spec-auth', targetType: 'wiki', objectId: null, ...common },
      { action: 'create', type: 'attachment', target: 'AUTH', targetType: 'epic', objectId: epic.id, ...common },
    ],
  });
  assert.deepEqual(writes(h.fake), [], 'dry-run writes nothing');

  const refused = await h.taigent(['upload', '--project', SLUG]);
  assert.equal(refused.code, 2);
  assert.match(refused.stdout, /\+ create wiki page spec-auth/);
  assert.match(refused.stdout, /\+ upload auth-overview\.pdf -> epic AUTH {2}\(12 bytes\)/);
  assert.match(refused.stderr, /refusing to upload without --yes/);
  assert.deepEqual(writes(h.fake), []);
});

test('an attachment whose target item is not on Taiga yet fails before any write (exit 5)', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: SLUG });
  await h.writeManifest(SLUG, 'backlog.yaml', BACKLOG);
  await writeProjectFile(h, 'files/login-flow.pdf', PDF);
  await h.writeManifest(SLUG, 'docs.yaml', STORY_DOCS);

  const result = await h.taigent(['upload', '--project', SLUG, '--yes']);

  assert.equal(result.code, 5);
  assert.match(result.stderr, /AUTH-LOGIN: no story tagged src:auth-login on Taiga yet; run `taigent apply --project demo --yes` first/);
  assert.deepEqual(writes(h.fake), []);
});

test('an upload interrupted by an expired token is sent again in full after the token is renewed', async (t) => {
  const h = await startHarness(t);
  const { story } = await appliedProject(h);
  await writeProjectFile(h, 'files/login-flow.pdf', PDF);
  await h.writeManifest(SLUG, 'docs.yaml', STORY_DOCS);
  h.fake.onRequest({ method: 'POST', path: '/userstories/attachments', run: () => h.fake.expireTokens() });

  const result = await h.taigent(['upload', '--project', SLUG, '--yes']);

  assert.equal(result.code, 0, result.stderr);
  // The first attempt got 401; the documented renewal (docs/cli.md §Credentials and environment) ran before the retry.
  assert.ok(h.fake.requests.some((r) => r.path === '/auth/refresh'));
  assert.deepEqual(
    h.fake.state.attachments.map((a) => ({ object_id: a.object_id, content: a.content })),
    [{ object_id: story.id, content: PDF }],
  );
});

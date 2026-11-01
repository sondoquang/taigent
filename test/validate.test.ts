import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import { startHarness, type Harness } from './support/harness.ts';

/** Writes a file referenced by docs.yaml, relative to the project's manifest directory. */
async function writeProjectFile(h: Harness, slug: string, file: string, content = 'x'): Promise<void> {
  const path = join(h.manifestsDir, slug, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

interface ErrorOutput {
  error: { kind: string; message: string; issues?: ManifestIssue[] };
}

/** No Taiga connection at all: validate must work offline, without any TAIGA_* variable. */
const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

const VALID_BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
    tags: [type:feature, area:auth]
  - key: BILLING-V2
    subject: Billing
`;

test('validate accepts a conventional backlog offline, without Taiga env vars', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', VALID_BACKLOG);

  const result = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /taiga[\\/]demo[\\/]backlog\.yaml: ok/);
  assert.deepEqual(h.fake.requests, []);
});

test('tags need a known prefix and a conventional value; src: is reserved for taigent', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
    tags: [feature, prio:high, type:epic, area:Auth Module, src:auth, type:bug]
`,
  );

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const { error } = result.json<ErrorOutput>();
  assert.equal(error.kind, 'validation');
  assert.deepEqual(
    error.issues?.map((i) => [i.file.replaceAll('\\', '/'), i.path, i.rule]),
    [
      ['taiga/demo/backlog.yaml', 'epics[0].tags[0]', 'tag-prefix'],
      ['taiga/demo/backlog.yaml', 'epics[0].tags[1]', 'tag-prefix'],
      ['taiga/demo/backlog.yaml', 'epics[0].tags[2]', 'tag-format'],
      ['taiga/demo/backlog.yaml', 'epics[0].tags[3]', 'tag-format'],
      ['taiga/demo/backlog.yaml', 'epics[0].tags[4]', 'tag-reserved'],
    ],
  );
  assert.match(result.stderr, /backlog\.yaml: epics\[0\]\.tags\[1\]: .*type:, area:.* \[tag-prefix\]/);

  // plan and apply refuse the same manifest with the validation exit code, before contacting Taiga.
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, 4);
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 4);
  assert.deepEqual(h.fake.requests, []);
});

test('docs.yaml: wiki slugs, attachment names, files and references to backlog keys are checked', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', VALID_BACKLOG);
  await writeProjectFile(h, 'demo', 'pages/spec-auth.md', '# Auth');
  await writeProjectFile(h, 'demo', 'files/auth-login-flow.pdf');
  await writeProjectFile(h, 'demo', 'files/Login Flow.PDF');
  await h.writeManifest(
    'demo',
    'docs.yaml',
    `wiki:
  - slug: spec-auth
    file: pages/spec-auth.md
  - slug: Spec Billing
    file: pages/missing.md
attachments:
  - target: AUTH
    file: files/auth-login-flow.pdf
    description: Login flow
  - target: BILLING
    file: files/Login Flow.PDF
  - target: wiki:spec-billing
    file: files/auth-login-flow.pdf
`,
  );

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  assert.deepEqual(
    result.json<ErrorOutput>().error.issues?.map((i) => [i.file.replaceAll('\\', '/'), i.path, i.rule]),
    [
      ['taiga/demo/docs.yaml', 'wiki[1].slug', 'wiki-slug'],
      ['taiga/demo/docs.yaml', 'wiki[1].file', 'file-exists'],
      ['taiga/demo/docs.yaml', 'attachments[1].target', 'key-reference'],
      ['taiga/demo/docs.yaml', 'attachments[1].file', 'attachment-name'],
      ['taiga/demo/docs.yaml', 'attachments[2].target', 'wiki-reference'],
    ],
  );
  assert.match(
    result.stderr,
    /docs\.yaml: attachments\[1\]\.target: no epic, story or task with key BILLING in backlog\.yaml \[key-reference\]/,
  );
});

test('validate lists every valid manifest of the project, docs.yaml included', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', VALID_BACKLOG);
  await writeProjectFile(h, 'demo', 'pages/spec-auth.md', '# Auth');
  await writeProjectFile(h, 'demo', 'files/auth-login-flow.pdf');
  await h.writeManifest(
    'demo',
    'docs.yaml',
    `wiki:
  - slug: spec-auth
    file: pages/spec-auth.md
attachments:
  - target: BILLING-V2
    file: files/auth-login-flow.pdf
  - target: wiki:spec-auth
    file: files/auth-login-flow.pdf
`,
  );

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<{ valid: boolean; projects: { slug: string; files: string[] }[] }>(), {
    valid: true,
    projects: [{ slug: 'demo', files: [join('taiga', 'demo', 'backlog.yaml'), join('taiga', 'demo', 'docs.yaml')] }],
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import { startHarness } from './support/harness.ts';

interface ErrorOutput {
  error: { kind: string; message: string; issues?: ManifestIssue[]; status?: number | null };
}

test('an invalid manifest exits 4, names file/path/rule, and never contacts Taiga', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Authentication
  - key: AUTH
    subject: Duplicate
  - key: bad key
    subject: ''
`,
  );

  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(text.code, 4);
  assert.match(text.stderr, /backlog\.yaml: epics\[1\]\.key: duplicate key AUTH/);

  const json = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(json.code, 4);
  const { error } = json.json<ErrorOutput>();
  assert.equal(error.kind, 'validation');
  assert.deepEqual(
    error.issues?.map((i) => [i.path, i.rule]),
    [
      ['epics[1].key', 'key-unique'],
      ['epics[2].key', 'key-format'],
      ['epics[2].subject', 'required'],
    ],
  );
  assert.deepEqual(h.fake.requests, []);
});

test('a missing backlog manifest is a validation error (exit 4)', async (t) => {
  const h = await startHarness(t);
  const result = await h.taigent(['plan', '--project', 'nowhere']);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /backlog\.yaml: manifest file not found/);
});

test('usage and configuration errors exit 2 and name the missing variable', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', 'epics: []\n');

  assert.equal((await h.taigent([])).code, 2);
  assert.equal((await h.taigent(['frobnicate', '--project', 'demo'])).code, 2);
  assert.equal((await h.taigent(['plan'])).code, 2);
  assert.equal((await h.taigent(['plan', '--project', '../escape'])).code, 2);
  assert.equal((await h.taigent(['plan', '--project', 'demo', '--bogus'])).code, 2);

  const noEnv = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGA_PASSWORD: undefined } });
  assert.equal(noEnv.code, 2);
  assert.match(noEnv.stderr, /TAIGA_PASSWORD/);

  const help = await h.taigent(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Exit codes/);
});

test('closed is gone: an unknown command (exit 2) that never contacts Taiga', async (t) => {
  const h = await startHarness(t);

  const result = await h.taigent(['closed', '--from', '2026-10-26', '--to', '2026-11-01']);

  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /unknown command "closed"/);
  assert.deepEqual(h.fake.requests, []);

  const help = await h.taigent(['--help']);
  assert.doesNotMatch(help.stdout, /\bclosed +List|closed and tickets|closed, tickets/);
});

test('Taiga and network failures exit 5', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', 'epics: [{ key: AUTH, subject: Authentication }]\n');

  const unknownProject = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(unknownProject.code, 5);
  assert.match(unknownProject.json<ErrorOutput>().error.message, /project "demo" not found/);

  h.fake.addProject({ slug: 'demo' });
  const badLogin = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGA_PASSWORD: 'wrong-password' } });
  assert.equal(badLogin.code, 5);
  assert.match(badLogin.stderr, /POST \/auth failed: HTTP 401/);
  assert.doesNotMatch(badLogin.stderr + badLogin.stdout, /wrong-password/);

  const unreachable = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGA_API_URL: 'http://127.0.0.1:9/api/v1' } });
  assert.equal(unreachable.code, 5);
  assert.match(unreachable.stderr, /cannot reach Taiga at http:\/\/127\.0\.0\.1:9\/api\/v1/);
});

test('a Taiga error while creating stops apply, names the key, and keeps what was created in state', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', 'epics:\n  - { key: AUTH, subject: Auth }\n  - { key: BILLING, subject: Billing }\n');
  // Let the first create through, fail the second one.
  h.fake.intercept({ method: 'POST', path: '/epics', after: 1, status: 500, body: { _error_message: 'boom' } });

  const failed = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(failed.code, 5);
  // Names the key, the operation and Taiga's own error.
  assert.match(failed.stderr, /create epic BILLING failed: POST \/epics failed: HTTP 500 \{"_error_message":"boom"\}/);
  assert.deepEqual(h.fake.state.epics.map((e) => e.subject), ['Auth']);
  assert.deepEqual(Object.keys((await h.readState('demo'))?.items ?? {}), ['AUTH']);

  const resumed = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual(h.fake.state.epics.map((e) => e.subject), ['Auth', 'Billing']);
});

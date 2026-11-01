import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import { startHarness } from './support/harness.ts';

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

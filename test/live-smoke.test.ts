// Keeps the opt-in live smoke test (test/live/taiga-smoke.live.ts, `npm run test:live`) honest without a real
// Taiga: it runs that file with `node --test`, its environment pointed at the in-process fake Taiga.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeTaiga, type FakeTaiga } from './support/fake-taiga.ts';

const SMOKE = fileURLToPath(new URL('./live/taiga-smoke.live.ts', import.meta.url));

interface SmokeRun {
  code: number | null;
  /** TAP output (stdout + stderr). */
  output: string;
}

/** Runs the live smoke file with `env` on top of a scrubbed environment (no real TAIGA_/TAIGENT_ values). */
async function runSmoke(env: Record<string, string>, extraArgs: string[] = []): Promise<SmokeRun> {
  const base: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // NODE_TEST_CONTEXT would make the nested `node --test` report to this runner instead of printing TAP.
    if (value !== undefined && !/^(TAIGA_|TAIGENT_|NODE_TEST_CONTEXT$)/i.test(name)) base[name] = value;
  }
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...extraArgs, SMOKE], {
    env: { ...base, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return { code, output };
}

/** Env of a smoke run against `fake`, project slug `test`. */
function fakeEnv(fake: FakeTaiga, extra: Record<string, string> = {}): Record<string, string> {
  return {
    TAIGA_API_URL: fake.url,
    TAIGA_USERNAME: fake.user.username,
    TAIGA_PASSWORD: fake.user.password,
    TAIGENT_LIVE_SMOKE: '1',
    TAIGENT_SMOKE_PROJECT: 'test',
    ...extra,
  };
}

function summary(output: string, name: 'pass' | 'fail' | 'skipped'): number {
  const match = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(output);
  assert.ok(match, `no "# ${name}" line in:\n${output}`);
  return Number(match[1]);
}

test('without TAIGENT_LIVE_SMOKE the live smoke test is skipped and contacts nothing', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  fake.addProject({ slug: 'test' });
  const env = fakeEnv(fake);
  delete (env as Record<string, string | undefined>).TAIGENT_LIVE_SMOKE;

  const run = await runSmoke(env);

  assert.equal(run.code, 0, run.output);
  assert.equal(summary(run.output, 'pass'), 0, run.output);
  assert.equal(summary(run.output, 'skipped'), 2, run.output);
  assert.deepEqual(fake.requests, []);
});

test('an enabled live smoke test without TAIGENT_SMOKE_PROJECT fails before contacting Taiga', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const env = fakeEnv(fake);
  delete (env as Record<string, string | undefined>).TAIGENT_SMOKE_PROJECT;

  const run = await runSmoke(env);

  assert.notEqual(run.code, 0, run.output);
  assert.match(run.output, /TAIGENT_SMOKE_PROJECT/);
  assert.deepEqual(fake.requests, []);
});

test('against a fake Taiga with the project seeded, the live smoke test passes and leaves no duplicates', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'test' });

  const run = await runSmoke(fakeEnv(fake));

  assert.equal(run.code, 0, run.output);
  assert.equal(summary(run.output, 'pass'), 1, run.output);
  assert.equal(summary(run.output, 'fail'), 0, run.output);
  // The fake, like taiga-back (TagsFilter in the epic list's filter_backends), filters /epics by tag.
  assert.match(run.output, /epic tag filter: GET \/epics\?project=\d+&tags=src:smoke-[a-z0-9]+-epic returned 1 of 2 epics: applied server-side/);

  assert.deepEqual(
    fake.state.epics.map((e) => e.tags.filter((tag) => tag.startsWith('src:')).map((tag) => tag.replace(/^src:smoke-[a-z0-9]+-/, 'src:smoke-*-'))),
    [['src:smoke-*-epic'], ['src:smoke-*-epic2']],
  );
  assert.equal(fake.state.userStories.length, 1);
  assert.equal(fake.state.tasks.length, 1);
  assert.equal(fake.state.tasks[0]!.user_story, fake.state.userStories[0]!.id);
  assert.deepEqual(
    fake.state.epicRelatedUserStories.map(({ epic, user_story }) => ({ epic, user_story })),
    [{ epic: fake.state.epics[0]!.id, user_story: fake.state.userStories[0]!.id }],
  );
  assert.equal(fake.state.wikiPages.length, 1);
  assert.deepEqual(
    fake.state.attachments.map((a) => ({ project: a.project, type: a.objectType, object_id: a.object_id })),
    [
      { project: project.id, type: 'epics', object_id: fake.state.epics[0]!.id },
      { project: project.id, type: 'wiki', object_id: fake.state.wikiPages[0]!.id },
    ],
  );
});

test('the upload limit probe reports an upload the server refuses with HTTP 413', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  fake.addProject({ slug: 'test' });
  fake.settings.maxBodyBytes = 64 * 1024;

  const run = await runSmoke(fakeEnv(fake, { TAIGENT_SMOKE_UPLOAD_PROBE_BYTES: String(128 * 1024) }), ['--test-name-pattern=probe']);

  assert.equal(run.code, 0, run.output);
  assert.equal(summary(run.output, 'pass'), 1, run.output);
  assert.match(run.output, /upload limit: 131072 bytes rejected \(HTTP 413\)/);
  assert.equal(fake.state.attachments.length, 0);
});

test('the upload limit probe runs alone (--test-name-pattern=probe) and reports an upload the server accepts', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  fake.addProject({ slug: 'test' });
  fake.settings.maxBodyBytes = 64 * 1024;

  const run = await runSmoke(fakeEnv(fake, { TAIGENT_SMOKE_UPLOAD_PROBE_BYTES: String(32 * 1024) }), ['--test-name-pattern=probe']);

  assert.equal(run.code, 0, run.output);
  assert.match(run.output, /upload limit: 32768 bytes accepted/);
  assert.deepEqual(fake.state.attachments.map((a) => a.content.length), [32 * 1024]);
  assert.deepEqual(fake.state.epics, [], 'the main smoke test did not run');
});

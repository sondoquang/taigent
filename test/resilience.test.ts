import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import { startHarness } from './support/harness.ts';

interface ErrorOutput {
  error: { kind: string; message: string; status?: number | null };
}

const authPaths = (h: { fake: { requests: { path: string }[] } }) =>
  h.fake.requests.filter((r) => r.path.startsWith('/auth')).map((r) => r.path);

const BACKLOG = `epics:
  - { key: AUTH, subject: Authentication }
  - { key: BILLING, subject: Billing }
  - { key: SEARCH, subject: Search }
`;

test('an access token that expires mid-apply is refreshed via /auth/refresh and the job completes', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  // by_slug, list epics and the first create go through; the token expires before the second create.
  h.fake.expireTokens({ after: 3 });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json<ApplyReport>().summary.created, 3);
  assert.deepEqual(h.fake.state.epics.map((e) => e.subject), ['Authentication', 'Billing', 'Search']);
  assert.deepEqual(
    h.fake.requests.filter((r) => r.path.startsWith('/auth')).map((r) => r.path),
    ['/auth', '/auth/refresh'],
  );
});

test('when the refresh token is revoked too, the CLI logs in again and completes', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  h.fake.expireTokens({ after: 3, refresh: true });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.epics.length, 3);
  assert.deepEqual(authPaths(h), ['/auth', '/auth/refresh', '/auth']);
});

test('TAIGA_TOKEN replaces username/password: no login, the token is sent as Bearer', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  const token = h.fake.issueToken();

  const result = await h.taigent(['apply', '--project', 'demo', '--yes'], {
    env: { TAIGA_TOKEN: token, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.epics.length, 3);
  assert.deepEqual(authPaths(h), []);
  assert.ok(h.fake.requests.every((r) => r.headers.authorization === `Bearer ${token}`));
});

test('a rejected TAIGA_TOKEN without username/password exits 5 and names TAIGA_TOKEN and the URL', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['plan', '--project', 'demo', '--json'], {
    env: { TAIGA_TOKEN: 'stale-token-value', TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined },
  });

  assert.equal(result.code, 5);
  const { error } = result.json<ErrorOutput>();
  assert.equal(error.kind, 'taiga');
  assert.equal(error.status, 401);
  assert.ok(error.message.includes(h.fake.url), error.message);
  assert.match(error.message, /TAIGA_TOKEN/);
  assert.match(result.stderr, /TAIGA_TOKEN/);
});

test('a rejected TAIGA_TOKEN falls back to TAIGA_USERNAME/TAIGA_PASSWORD when they are set', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGA_TOKEN: 'stale-token-value' } });

  assert.equal(result.code, 3, result.stderr);
  assert.deepEqual(authPaths(h), ['/auth']);
});

test('429 responses are retried with backoff that honors Retry-After, then the job completes', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  h.fake.intercept({ method: 'POST', path: '/epics', after: 1, times: 2, status: 429, headers: { 'retry-after': '5' } });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes'], { env: { TAIGENT_RETRY_UNIT_MS: '20' } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(h.fake.state.epics.map((e) => e.subject), ['Authentication', 'Billing', 'Search']);
  const creates = h.fake.requests.filter((r) => r.method === 'POST' && r.path === '/epics');
  assert.equal(creates.length, 5);
  // Retry-After: 5 at 20 ms per second → at least 100 ms between the throttled attempts.
  assert.ok(creates[2]!.at - creates[1]!.at >= 95, `waited ${creates[2]!.at - creates[1]!.at} ms`);
  assert.ok(creates[3]!.at - creates[2]!.at >= 95, `waited ${creates[3]!.at - creates[2]!.at} ms`);
});

test('429 retries are bounded: a Taiga that keeps throttling fails with exit 5', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  h.fake.intercept({ method: 'GET', path: '/epics', times: 100, status: 429, body: { detail: 'Request was throttled.' } });

  const result = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGENT_RETRY_UNIT_MS: '1' } });

  assert.equal(result.code, 5);
  assert.match(result.stderr, /GET \/epics failed: HTTP 429 .*throttled/);
  assert.equal(h.fake.requests.filter((r) => r.path === '/epics').length, 6, 'one attempt + 5 retries');
});

test('missing configuration names the variables to set', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const noUrl = await h.taigent(['plan', '--project', 'demo', '--json'], { env: { TAIGA_API_URL: undefined } });
  assert.equal(noUrl.code, 2);
  assert.match(noUrl.json<ErrorOutput>().error.message, /missing environment variable\(s\): TAIGA_API_URL/);

  const noAuth = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined } });
  assert.equal(noAuth.code, 2);
  assert.match(noAuth.stderr, /TAIGA_USERNAME, TAIGA_PASSWORD \(or set TAIGA_TOKEN/);

  const badUnit = await h.taigent(['plan', '--project', 'demo'], { env: { TAIGENT_RETRY_UNIT_MS: 'soon' } });
  assert.equal(badUnit.code, 2);
  assert.match(badUnit.stderr, /TAIGENT_RETRY_UNIT_MS/);
  assert.deepEqual(h.fake.requests, []);
});

test('a refused login names the URL and the variables to check', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['plan', '--project', 'demo', '--json'], { env: { TAIGA_PASSWORD: 'not-the-password' } });

  assert.equal(result.code, 5);
  const { message } = result.json<ErrorOutput>().error;
  assert.ok(message.includes(`login to ${h.fake.url} failed`), message);
  assert.match(message, /TAIGA_USERNAME.*TAIGA_PASSWORD/);
});

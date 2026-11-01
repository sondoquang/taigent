import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  // Documented contract (docs/cli.md §Environment): a 401 renews the token with POST /auth/refresh, no new login.
  assert.deepEqual(authPaths(h), ['/auth', '/auth/refresh']);
});

test('when the refresh token is revoked too, the CLI logs in again and completes', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  h.fake.expireTokens({ after: 3, refresh: true });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(h.fake.state.epics.length, 3);
  // Documented contract: a rejected refresh falls back to a new login.
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
  // 3 creates + the 2 throttled attempts retried: the documented Retry-After waits are measured between them.
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
  // Documented contract (docs/cli.md §Environment): up to 5 retries per request.
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

  const userinfo = await h.taigent(['plan', '--project', 'demo', '--json'], { env: { TAIGA_API_URL: h.fake.url.replace('://', '://bot:pw@') } });
  assert.equal(userinfo.code, 2);
  assert.match(userinfo.json<ErrorOutput>().error.message, /TAIGA_API_URL must not contain credentials.*TAIGA_USERNAME and TAIGA_PASSWORD/);
  assert.deepEqual(h.fake.requests, []);
});

test('variables missing from the environment are read from .env in the working directory; the environment wins', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  const { username, password } = h.fake.user;
  writeFileSync(join(h.cwd, '.env'), `# credentials\nTAIGA_API_URL=http://127.0.0.1:9/api/v1\nTAIGA_USERNAME=${username}\nTAIGA_PASSWORD="${password}"\n`);
  const fromDotEnv = { TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

  // TAIGA_API_URL from the environment (the fake) beats the unreachable one in .env; the login comes from .env.
  const plan = await h.taigent(['plan', '--project', 'demo', '--json'], { env: fromDotEnv });
  assert.equal(plan.code, 3, plan.stderr);

  // A password from .env is redacted like one from the environment.
  h.fake.intercept({ method: 'POST', path: '/auth', status: 400, bodyFrom: (r) => ({ _error_message: `bad login ${JSON.stringify(r.body)}` }) });
  const echoed = await h.taigent(['plan', '--project', 'demo', '--json'], { env: fromDotEnv });
  assert.equal(echoed.code, 5, echoed.stderr);
  assert.ok(!`${echoed.stdout}${echoed.stderr}`.includes(password), echoed.stderr);
  assert.match(echoed.stderr, /\[redacted\]/);
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

test('stdout, stderr and --json output never contain a password or token, on success and on every error path', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  await h.writeManifest('broken', 'backlog.yaml', 'epics: [{ key: bad key }]\n');
  const wrongPassword = 'wrong-secret-pass';
  const bogusToken = 'bogus-secret-token';
  const noCredentials = { TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };
  const outputs: string[] = [];

  /** Runs `args` as text and as --json (calling `setup` before each run) and checks the exit code. */
  async function scenario(
    name: string,
    expectedCode: number,
    args: string[],
    env: Record<string, string | undefined> = {},
    setup: () => void = () => {},
  ): Promise<void> {
    for (const extra of [[], ['--json']]) {
      setup();
      const result = await h.taigent([...args, ...extra], { env: { TAIGENT_RETRY_UNIT_MS: '0', ...env } });
      assert.equal(result.code, expectedCode, `${name} ${extra.join('')}: ${result.stderr}`);
      outputs.push(`--- ${name} ${extra.join('')}\n${result.stdout}\n${result.stderr}`);
    }
  }

  // Success paths, including a token renewed mid-run and TAIGA_TOKEN.
  await scenario('plan', 3, ['plan', '--project', 'demo']);
  await scenario('apply with refresh', 0, ['apply', '--project', 'demo', '--yes'], {}, () => h.fake.expireTokens({ after: 1 }));
  await scenario('relogin', 0, ['plan', '--project', 'demo'], {}, () => h.fake.expireTokens({ after: 1, refresh: true }));
  const token = h.fake.issueToken();
  await scenario('TAIGA_TOKEN', 0, ['plan', '--project', 'demo'], { TAIGA_TOKEN: token, ...noCredentials });

  // Usage, configuration and validation errors.
  await scenario('usage', 2, ['plan']);
  await scenario('missing username', 2, ['plan', '--project', 'demo'], { TAIGA_USERNAME: undefined });
  await scenario('bad retry unit', 2, ['plan', '--project', 'demo'], { TAIGENT_RETRY_UNIT_MS: 'x' });
  await scenario('apply without --yes', 0, ['apply', '--project', 'demo']);
  await scenario('validation', 4, ['plan', '--project', 'broken']);

  // Taiga errors: refused login, rejected token, failed re-login, throttling, unreachable host,
  // and a Taiga that echoes the credentials and token it received back in its error bodies.
  await scenario('wrong password', 5, ['plan', '--project', 'demo'], { TAIGA_PASSWORD: wrongPassword });
  await scenario('rejected token', 5, ['plan', '--project', 'demo'], { TAIGA_TOKEN: bogusToken, ...noCredentials });
  await scenario('rejected token and password', 5, ['plan', '--project', 'demo'], {
    TAIGA_TOKEN: bogusToken,
    TAIGA_PASSWORD: wrongPassword,
  });
  await scenario('failed re-login', 5, ['plan', '--project', 'demo'], {}, () => {
    h.fake.expireTokens({ after: 1, refresh: true });
    h.fake.intercept({ method: 'POST', path: '/auth', after: 1, status: 401, body: { detail: 'No active account' } });
  });
  await scenario('throttled', 5, ['plan', '--project', 'demo'], {}, () =>
    h.fake.intercept({ method: 'GET', path: '/epics', times: 6, status: 429 }),
  );
  await scenario('unreachable', 5, ['plan', '--project', 'demo'], { TAIGA_API_URL: 'http://127.0.0.1:9/api/v1' });
  await scenario('login echo', 5, ['plan', '--project', 'demo'], {}, () =>
    h.fake.intercept({ method: 'POST', path: '/auth', status: 400, bodyFrom: (r) => ({ _error_message: `bad login ${JSON.stringify(r.body)}` }) }),
  );
  await scenario('header echo', 5, ['plan', '--project', 'demo'], {}, () =>
    h.fake.intercept({ method: 'GET', path: '/epics', status: 400, bodyFrom: (r) => ({ _error_message: `bad request ${JSON.stringify(r.headers)}` }) }),
  );
  await h.writeManifest('demo', 'backlog.yaml', `${BACKLOG}  - { key: EXTRA, subject: Extra }\n`);
  await scenario('mid-apply echo', 5, ['apply', '--project', 'demo', '--yes'], { TAIGA_TOKEN: token }, () =>
    h.fake.intercept({ method: 'POST', path: '/epics', status: 500, bodyFrom: (r) => ({ echoed: r.headers.authorization }) }),
  );

  // Credentials embedded in TAIGA_API_URL (user:password@) are a configuration error that never echoes the URL.
  const urlPassword = 'url-secret-pass';
  const urlWithUserinfo = h.fake.url.replace('://', `://taigent-bot:${urlPassword}@`);
  await scenario('URL userinfo', 2, ['plan', '--project', 'demo'], { TAIGA_API_URL: urlWithUserinfo });
  await scenario('URL userinfo, unreachable', 2, ['plan', '--project', 'demo'], { TAIGA_API_URL: `http://bot:${urlPassword}@127.0.0.1:9/api/v1` });

  // Internal error (exit 1, stack trace printed): a hand-broken state.json whose text ends up in the error message.
  await h.writeManifest('demo', 'state.json', h.fake.user.password);
  await scenario('internal error', 1, ['apply', '--project', 'demo', '--yes']);
  const freshToken = h.fake.issueToken();
  await scenario('internal error with token', 1, ['apply', '--project', 'demo', '--yes'], { TAIGA_TOKEN: freshToken, ...noCredentials }, () =>
    writeFileSync(join(h.manifestsDir, 'demo', 'state.json'), freshToken),
  );

  const secrets = [h.fake.user.password, wrongPassword, bogusToken, urlPassword, ...h.fake.issuedTokens];
  const all = outputs.join('\n');
  for (const secret of secrets) assert.ok(!all.includes(secret), `output leaks ${secret}:\n${all}`);
  assert.match(all, /\[redacted\]/, 'the echoing scenarios must have exercised redaction');
});

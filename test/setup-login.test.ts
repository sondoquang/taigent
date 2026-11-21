// `taigent setup` after writing its files: the login (stored, TAIGA_* or missing), the login check (as `whoami`) and
// the MCP check (the `taiga` server entry setup wrote answering `listProjects`), against the fake Taiga. The interactive
// login of a terminal is not tested (as for `taigent login`): every run here has no TTY, so a missing login is never
// asked for. The user entry runs the global `taigent`: a bin directory first on PATH holds a `taigent` shim (sh and
// .cmd) running this repository's bin/taigent.js; the project entry runs `node_modules/taigent`, a link to it.

import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { storeLogin } from '../src/login.ts';
import { Secrets } from '../src/secrets.ts';
import { BIN, startHarness, type Harness } from './support/harness.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The name of PATH in this process's env (`Path` on Windows): the run env overrides that one, never adds a second. */
const PATH = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';

/** Run env without TAIGA_* values: the stored login is the only credential. */
const LOGIN_ONLY = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

type Check = { status: 'ok' | 'failed' | 'skipped'; error?: string; reason?: string };
interface SetupReport {
  files: { path: string; status: string }[];
  login: Check & { source: 'stored' | 'environment' | 'missing'; apiUrl?: string; user?: { id: number; username: string } };
  mcp: Check & { projects?: number };
}

function login(h: Harness) {
  const { username, password } = h.fake.user;
  return storeLogin({ env: h.env, apiUrl: h.fake.url, username, password, secrets: new Secrets() });
}

/**
 * A home with Claude Code, a Taiga project the fake user is a member of, and the `taigent` of this repository installed
 * as setup's entries expect it: a global `taigent` first on PATH, and (`linked`) `node_modules/taigent` in the project.
 */
async function prepare(h: Harness, { linked = true } = {}): Promise<void> {
  await mkdir(join(h.home, '.claude'));
  h.fake.addProject({ slug: 'demo', name: 'Demo', members: [h.fake.user.id] });
  const bin = join(h.home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'taigent'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  await chmod(join(bin, 'taigent'), 0o755);
  await writeFile(join(bin, 'taigent.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
  h.env[PATH] = `${bin}${delimiter}${process.env[PATH]}`;
  if (linked) {
    await mkdir(join(h.cwd, 'node_modules'));
    await symlink(REPO_ROOT, join(h.cwd, 'node_modules', 'taigent'), 'junction');
  }
}

const authCalls = (h: Harness) => h.fake.requests.filter((r) => r.path === '/auth' || r.path === '/auth/refresh').map((r) => r.path);

test('setup with a stored login checks it and the MCP server without asking for a password', async (t) => {
  const h = await startHarness(t);
  await prepare(h);
  await login(h);

  const result = await h.taigent(['setup', '--json'], { env: LOGIN_ONLY });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.ok(report.files.length > 0 && report.files.every(({ status }) => status === 'created'), result.stdout);
  assert.deepEqual(report.login, { source: 'stored', status: 'ok', apiUrl: h.fake.url, user: { id: h.fake.user.id, username: h.fake.user.username } });
  assert.deepEqual(report.mcp, { status: 'ok', projects: 1 });
  assert.deepEqual(authCalls(h), ['/auth'], 'only the stored login itself sent the password');
  assert.ok(h.fake.requests.some((r) => r.method === 'GET' && r.path === '/projects'), 'taigent mcp listed the projects');
});

test('setup --project with TAIGA_* credentials checks them and the MCP server, for a password and for a token', async (t) => {
  for (const variables of ['password', 'token'] as const) {
    const h = await startHarness(t);
    await prepare(h);
    const env = variables === 'token' ? { TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined, TAIGA_TOKEN: h.fake.issueToken() } : {};

    const result = await h.taigent(['setup', '--project', '--json'], { env });

    assert.equal(result.code, 0, `${variables}: ${result.stderr}`);
    const report = result.json<SetupReport>();
    assert.deepEqual(report.login, { source: 'environment', status: 'ok', apiUrl: h.fake.url, user: { id: h.fake.user.id, username: h.fake.user.username } }, variables);
    assert.deepEqual(report.mcp, { status: 'ok', projects: 1 }, variables);
  }
});

test('setup without a login or a terminal installs everything, says how to log in, and reads no password', async (t) => {
  const h = await startHarness(t);
  await prepare(h);
  // TAIGA_API_URL alone is no credential.
  const env = { TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

  const json = await h.taigent(['setup', '--json'], { env });
  const text = await h.taigent(['setup'], { env });

  assert.equal(json.code, 0, json.stderr);
  const report = json.json<SetupReport>();
  assert.ok(report.files.some(({ path }) => path === '~/.claude.json'), json.stdout);
  assert.equal(report.login.source, 'missing');
  assert.equal(report.login.status, 'skipped');
  assert.match(report.login.reason!, /run `taigent login` in your own terminal/);
  assert.equal(report.mcp.status, 'skipped');
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^Login: not logged in to Taiga: run `taigent login` in your own terminal/m);
  assert.match(text.stdout, /^MCP server: not checked/m);
  assert.doesNotMatch(text.stdout, /Password/);
  assert.deepEqual(h.fake.requests, [], 'nothing reached Taiga');
});

test('setup exits 5 and names the login check when Taiga rejects the credentials, files still installed', async (t) => {
  const wrongPassword = await startHarness(t);
  await prepare(wrongPassword);

  const result = await wrongPassword.taigent(['setup', '--json'], { env: { TAIGA_PASSWORD: 'wrong' } });

  assert.equal(result.code, 5, result.stderr);
  const report = result.json<SetupReport>();
  assert.ok(report.files.length > 0, result.stdout);
  assert.equal(report.login.source, 'environment');
  assert.equal(report.login.status, 'failed');
  assert.match(report.login.error!, /check TAIGA_USERNAME and TAIGA_PASSWORD/);
  assert.deepEqual(report.mcp, { status: 'skipped', reason: 'the login check failed' });
  assert.match(result.stderr, /setup: the login check failed/);

  // A stored login Taiga no longer renews.
  const expired = await startHarness(t);
  await prepare(expired);
  await login(expired);
  expired.fake.expireTokens({ refresh: true });

  const text = await expired.taigent(['setup'], { env: LOGIN_ONLY });

  assert.equal(text.code, 5, text.stderr);
  assert.match(text.stdout, /^Login check failed: .*taigent login/m);
  assert.match(text.stderr, /setup: the login check failed/);
});

test('setup exits 5 and names the MCP check when taigent mcp gets no answer from Taiga', async (t) => {
  const h = await startHarness(t);
  await prepare(h);
  // The login check reads /users/me first; then listProjects of taigent mcp reads it and fails.
  h.fake.intercept({ method: 'GET', path: '/users/me', after: 1, times: 10, status: 500, body: { _error_message: 'boom' } });

  const result = await h.taigent(['setup', '--project', '--json']);

  assert.equal(result.code, 5, result.stderr);
  const report = result.json<SetupReport>();
  assert.equal(report.login.status, 'ok');
  assert.equal(report.mcp.status, 'failed');
  assert.match(report.mcp.error!, /listProjects/);
  assert.match(result.stderr, /setup: the MCP check failed/);
});

test('setup checks the server entry it wrote: with no taigent on PATH the MCP check fails with the fix (exit 2), and nothing reaches Taiga from it', async (t) => {
  const h = await startHarness(t);
  await prepare(h);
  // Only the system directory cmd.exe sits in (Windows) is left on PATH: no taigent, so `npx taigent setup` was used.
  h.env[PATH] = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : join(h.home, 'empty');

  const result = await h.taigent(['setup', '--json']);
  const text = await h.taigent(['setup']);

  assert.equal(result.code, 2, result.stderr);
  const report = result.json<SetupReport>();
  assert.equal(report.login.status, 'ok');
  assert.equal(report.mcp.status, 'failed');
  assert.match(report.mcp.error!, /taigent is not on PATH; run npm i -g taigent, then taigent setup again/);
  assert.match(result.stderr, /setup: the MCP check failed/);
  assert.ok(!h.fake.requests.some((r) => r.path === '/projects'), 'no server listed the projects');
  assert.equal(text.code, 2, text.stderr);
  assert.match(text.stdout, /^MCP check failed: cannot start the taiga server \((cmd \/c )?taigent mcp\)/m);
  assert.doesNotMatch(text.stdout, /^Next:/m);
});

test('setup --project before npm install does not check the server, says to run npm install, and exits 0', async (t) => {
  const h = await startHarness(t);
  await prepare(h, { linked: false });

  const result = await h.taigent(['setup', '--project', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<SetupReport>();
  assert.equal(report.login.status, 'ok');
  assert.equal(report.mcp.status, 'skipped');
  assert.match(report.mcp.reason!, /node_modules\/taigent is not installed yet: run npm install/);
  assert.ok(!h.fake.requests.some((r) => r.path === '/projects'), 'no server listed the projects');
});

test('setup --dry-run neither logs in nor checks anything', async (t) => {
  for (const env of [{}, LOGIN_ONLY]) {
    const h = await startHarness(t);
    await prepare(h);
    if (env === LOGIN_ONLY) await login(h);
    const before = h.fake.requests.length;

    const result = await h.taigent(['setup', '--dry-run', '--json'], { env });

    assert.equal(result.code, 3, result.stderr);
    const report = result.json<SetupReport>();
    assert.equal(report.login.source, env === LOGIN_ONLY ? 'stored' : 'environment');
    assert.equal(report.login.status, 'skipped');
    assert.equal(report.mcp.status, 'skipped');
    assert.equal(h.fake.requests.length, before, 'nothing reached Taiga');
  }
});

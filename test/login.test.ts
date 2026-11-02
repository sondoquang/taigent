// `taigent login` / logout / whoami / mcp against the fake Taiga. Login itself reads the password from a terminal,
// which a test cannot provide: tests store the login through `storeLogin` (what `taigent login` calls once it has the
// password) and run every other command as a user would. The harness keeps the store in a temp config directory.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { storeLogin } from '../src/login.ts';
import { Secrets } from '../src/secrets.ts';
import { BIN, childEnv, startHarness, type Harness } from './support/harness.ts';

/** Run env without TAIGA_* values: the stored login is the only credential. */
const LOGIN_ONLY = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

interface Whoami {
  apiUrl: string;
  user: { id: number; username: string };
  credentials: { source: string; method?: string };
}

function login(h: Harness, application?: string) {
  const { username, password } = h.fake.user;
  return storeLogin({ env: h.env, apiUrl: h.fake.url, username, password, application, secrets: new Secrets() });
}

/** Everything taigent wrote to its config directory: what a copied disk would reveal. */
async function storedFiles(h: Harness): Promise<string> {
  const names = await readdir(h.configDir).catch(() => []);
  return (await Promise.all(names.map((name) => readFile(join(h.configDir, name), 'utf8')))).join('\n');
}

const authCalls = (h: Harness) => h.fake.requests.filter((r) => r.path === '/auth' || r.path === '/auth/refresh').map((r) => r.path);

test('a stored login replaces TAIGA_* credentials, and the password is never stored', async (t) => {
  const h = await startHarness(t);
  await login(h);

  const files = await storedFiles(h);
  assert.ok(!files.includes(h.fake.user.password), 'password not stored');
  const result = await h.taigent(['whoami', '--json'], { env: LOGIN_ONLY });

  assert.equal(result.code, 0, result.stderr);
  const whoami = result.json<Whoami>();
  assert.equal(whoami.user.username, h.fake.user.username);
  assert.deepEqual(whoami.credentials, { source: 'login', method: 'refresh-token', store: `the file ${join(h.configDir, 'credentials.json')}` });
  assert.deepEqual(authCalls(h), ['/auth'], 'only the login itself sent the password');
});

test('an expired access token is refreshed once, and later runs use the rotated pair', async (t) => {
  const h = await startHarness(t);
  await login(h);
  h.fake.expireTokens();

  const first = await h.taigent(['whoami'], { env: LOGIN_ONLY });
  const second = await h.taigent(['whoami'], { env: LOGIN_ONLY });

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(authCalls(h), ['/auth', '/auth/refresh']);
});

test('concurrent runs share one refresh: the others adopt the rotated pair instead of spending it', async (t) => {
  const h = await startHarness(t);
  await login(h);
  h.fake.expireTokens();

  const results = await Promise.all([1, 2, 3, 4].map(() => h.taigent(['whoami'], { env: LOGIN_ONLY })));

  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(authCalls(h), ['/auth', '/auth/refresh']);
});

test('a stored login that can no longer be refreshed exits 5 and asks for taigent login', async (t) => {
  const h = await startHarness(t);
  await login(h);
  h.fake.expireTokens({ refresh: true });

  const result = await h.taigent(['whoami'], { env: LOGIN_ONLY });

  assert.equal(result.code, 5);
  assert.match(result.stderr, /expired or was revoked.*npx taigent login/);
  assert.deepEqual(authCalls(h), ['/auth', '/auth/refresh'], 'no new password login');
});

test('without credentials or a stored login, commands exit 2 and say how to log in', async (t) => {
  const h = await startHarness(t);

  const result = await h.taigent(['whoami'], { env: LOGIN_ONLY });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /not logged in to Taiga: run `npx taigent login`.*TAIGA_USERNAME and TAIGA_PASSWORD \(or TAIGA_TOKEN\)/);
});

test('TAIGA_API_URL naming another Taiga than the stored login is a usage error', async (t) => {
  const h = await startHarness(t);
  await login(h);

  const result = await h.taigent(['whoami'], { env: { ...LOGIN_ONLY, TAIGA_API_URL: 'https://other.example.test/api/v1' } });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /stored login is for http:\/\/127\.0\.0\.1/);
  assert.equal(h.fake.requests.length, 1, 'only the login reached Taiga');
});

test('application token login: sent as Application, survives token expiry, deleted on Taiga by logout', async (t) => {
  const h = await startHarness(t);
  const application = h.fake.addApplication('Taigent');
  await login(h, application.id);
  h.fake.expireTokens({ refresh: true });

  const whoami = await h.taigent(['whoami', '--json'], { env: LOGIN_ONLY });

  assert.equal(whoami.code, 0, whoami.stderr);
  assert.equal(whoami.json<Whoami>().credentials.method, 'application-token');
  assert.match(String(h.fake.requests.at(-1)?.headers.authorization), /^Application application-/);
  assert.ok(!(await storedFiles(h)).includes(h.fake.user.password), 'password not stored');

  const logout = await h.taigent(['logout'], { env: LOGIN_ONLY });

  assert.equal(logout.code, 0, logout.stderr);
  assert.match(logout.stdout, /Deleted 1 application token/);
  assert.deepEqual(h.fake.state.applicationTokens, []);
  assert.equal(await storedFiles(h), '', 'nothing left in the config directory');
  assert.equal((await h.taigent(['whoami'], { env: LOGIN_ONLY })).code, 2);
});

test('login with an unknown Application id fails and stores nothing', async (t) => {
  const h = await startHarness(t);

  await assert.rejects(login(h, 'no-such-application'), /application "no-such-application" not found.*ask the instance admin/);
  assert.equal(await storedFiles(h), '');
});

test('taigent login refuses to read a password without a terminal', async (t) => {
  const h = await startHarness(t);

  const result = await h.taigent(['login'], { env: LOGIN_ONLY });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /reads your password from a terminal/);
  assert.deepEqual(h.fake.requests, []);
});

/** The part of an MCP JSON-RPC response the tests read. */
interface McpResponse {
  id?: number;
  result?: { content?: { text: string }[]; isError?: boolean };
}

/** A `taigent mcp` child speaking MCP (JSON-RPC lines) on stdin/stdout. */
function startMcp(h: Harness, env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: h.cwd, env: childEnv({ ...h.env, ...env }), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close') as Promise<[number | null]>;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const pending = new Map<number, (message: McpResponse) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as McpResponse;
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    const { promise, resolve } = Promise.withResolvers<McpResponse>();
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  };
  return {
    stderr: () => stderr,
    async start() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'taigent-test', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
      const { result } = await request('tools/call', { name, arguments: args });
      return { text: result?.content?.map((c) => c.text).join('\n') ?? '', isError: result?.isError === true };
    },
    /** Closes stdin like an agent ending the session; resolves with the exit code. Safe to call twice. */
    async close(): Promise<number | null> {
      child.stdin.end();
      const [code] = await closed;
      return code;
    },
  };
}

test('taigent mcp serves the Taiga MCP tools with the stored login and refuses any other login', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo', name: 'Demo', members: [h.fake.user.id] });
  await login(h);
  const mcp = startMcp(h, LOGIN_ONLY);
  // Closed in the test, not in t.after: the harness's after hook deletes the child's working directory first.
  try {
    await mcp.start();
    const project = await mcp.callTool('getProject', { projectIdentifier: 'demo' });
    const takeover = await mcp.callTool('authenticate', { username: 'mallory', password: 'not-the-proxy-password' });

    assert.match(project.text, /Name: Demo/, mcp.stderr());
    assert.match(takeover.text, /fail/i);
    assert.deepEqual(authCalls(h), ['/auth'], 'no login, and no other credentials, reached Taiga');
    for (const request of h.fake.requests.slice(1)) {
      assert.ok(h.fake.issuedTokens.includes(String(request.headers.authorization).replace(/^Bearer /, '')), `${request.path} carried the stored token`);
    }
  } finally {
    assert.equal(await mcp.close(), 0, mcp.stderr());
  }
});

test('taigent mcp renews an expired stored login for the server', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo', name: 'Demo', members: [h.fake.user.id] });
  await login(h);
  const mcp = startMcp(h, LOGIN_ONLY);
  try {
    await mcp.start();
    h.fake.expireTokens();

    const project = await mcp.callTool('getProject', { projectIdentifier: 'demo' });

    assert.match(project.text, /Name: Demo/, mcp.stderr());
    assert.deepEqual(authCalls(h), ['/auth', '/auth/refresh']);
  } finally {
    await mcp.close();
  }
});

test('taigent mcp without credentials or a stored login exits 2 before serving', async (t) => {
  const h = await startHarness(t);

  const result = await h.taigent(['mcp'], { env: LOGIN_ONLY });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /not logged in to Taiga/);
  assert.equal(result.stdout, '', 'stdout is the MCP channel');
});

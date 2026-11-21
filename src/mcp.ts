// `taigent mcp`: starts the Taiga MCP server (taiga-mcp-server, pinned in package.json) in this process, for
// `.mcp.json` / `.codex/config.toml`. taiga-mcp-server only logs in with TAIGA_USERNAME/TAIGA_PASSWORD, so with a
// stored login (or TAIGA_TOKEN) the server talks to a proxy on 127.0.0.1 instead of Taiga:
// - the server gets a random proxy password, never a real one, and the proxy answers its `POST /auth` with the
//   stored user and a proxy token; any other username/password (e.g. the MCP `authenticate` tool) is refused;
// - every other request needs that proxy token and is forwarded to Taiga with the stored login's Authorization
//   header, renewed once on 401.
// With TAIGA_USERNAME and TAIGA_PASSWORD set (environment or .env) the server logs in itself, as before.
// stdout is the MCP channel: everything this module reports goes to stderr.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, constants } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { errorMessage } from './guards.ts';
import type { Secrets } from './secrets.ts';
import { TaigaAuthError, type TaigaAuthorizer } from './taiga/client.ts';

/** Request headers not forwarded to Taiga: hop-by-hop, the proxy's own authorization, and what fetch sets itself. */
const DROPPED_REQUEST_HEADERS: Record<string, true> = {
  host: true, connection: true, 'keep-alive': true, 'transfer-encoding': true, 'content-length': true, authorization: true,
  'accept-encoding': true, upgrade: true, expect: true,
};
/** Response headers not passed back: fetch has already decoded and de-chunked the body. */
const DROPPED_RESPONSE_HEADERS: Record<string, true> = {
  connection: true, 'keep-alive': true, 'transfer-encoding': true, 'content-length': true, 'content-encoding': true,
};

export interface McpProxy {
  /** TAIGA_API_URL for the MCP server. */
  url: string;
  /** TAIGA_PASSWORD for the MCP server; also the Bearer token the proxy accepts. */
  password: string;
  close(): Promise<void>;
}

interface ProxyReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const jsonReply = (status: number, body: unknown): ProxyReply => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(body)),
});

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !Object.hasOwn(DROPPED_REQUEST_HEADERS, name)) result[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Starts the proxy in front of `apiUrl`, authorizing every request with `authorizer`. */
export async function startProxy(options: { apiUrl: string; authorizer: TaigaAuthorizer; secrets: Secrets; log: (text: string) => void }): Promise<McpProxy> {
  const { authorizer, secrets, log } = options;
  const upstream = new URL(options.apiUrl.replace(/\/+$/, ''));
  const basePath = upstream.pathname.replace(/\/+$/, '');
  const password = randomBytes(32).toString('base64url');
  secrets.add(password);

  /** Sends one request to Taiga; on 401, renews the authorization once and resends. */
  async function forward(method: string, pathAndQuery: string, headers: Record<string, string>, body: Buffer): Promise<ProxyReply> {
    const send = (authorization: string) =>
      fetch(`${upstream.origin}${basePath}${pathAndQuery}`, {
        method,
        headers: { ...headers, authorization },
        body: method === 'GET' || method === 'HEAD' || body.length === 0 ? undefined : body,
        redirect: 'manual',
      });
    const sent = authorizer.authorization();
    let response = await send(sent);
    if (response.status === 401 && (await authorizer.renew(sent))) response = await send(authorizer.authorization());
    const replyHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!Object.hasOwn(DROPPED_RESPONSE_HEADERS, name)) replyHeaders[name] = value;
    });
    return { status: response.status, headers: replyHeaders, body: Buffer.from(await response.arrayBuffer()) };
  }

  async function handle(req: IncomingMessage): Promise<ProxyReply> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return jsonReply(404, { _error_message: 'Not found.' });
    const path = url.pathname.slice(basePath.length) || '/';
    const method = req.method ?? 'GET';
    const body = await readBody(req);

    if (method === 'POST' && path.replace(/\/+$/, '') === '/auth') {
      let login: unknown;
      try {
        login = JSON.parse(body.toString('utf8'));
      } catch {
        login = undefined;
      }
      if ((login as { password?: unknown } | undefined)?.password !== password) {
        log('taigent mcp: refused a login with other credentials (the MCP authenticate tool); the server acts as the stored login only\n');
        return jsonReply(401, { _error_message: 'No active account found with the given credentials', _error_type: 'taiga.base.exceptions.NotAuthenticated' });
      }
      const me = await forward('GET', '/users/me', { accept: 'application/json' }, Buffer.alloc(0));
      if (me.status !== 200) return me;
      return jsonReply(200, { ...JSON.parse(me.body.toString('utf8')), auth_token: password, refresh: password });
    }

    if (req.headers.authorization !== `Bearer ${password}`) {
      return jsonReply(401, { _error_message: 'Invalid token', _error_type: 'taiga.base.exceptions.NotAuthenticated' });
    }
    return forward(method, `${path}${url.search}`, forwardedHeaders(req.headers), body);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req).then(
      (reply) => {
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      },
      (error: unknown) => {
        // A login that can no longer be renewed is the user's to fix; anything else is Taiga being unreachable.
        const expired = error instanceof TaigaAuthError;
        const message = secrets.redact(`taigent mcp: ${errorMessage(error)}`);
        log(`${message}\n`);
        const reply = jsonReply(expired ? 401 : 502, { _error_message: message, _error_type: 'taigent.proxy' });
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${basePath}`,
    password,
    close: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => resolve());
      return promise;
    },
  };
}

/**
 * Loads taiga-mcp-server, which starts serving MCP on stdin/stdout as soon as its module runs, and resolves when
 * the agent closes stdin. Set its TAIGA_* variables first: it reads them while loading.
 */
export async function serveMcp(env: Record<string, string>): Promise<void> {
  Object.assign(process.env, env);
  const stdinClosed = once(process.stdin, 'end');
  // A runtime specifier: taiga-mcp-server ships no type declarations, and it must load after the env is set.
  const server = 'taiga-mcp-server';
  await import(server);
  await stdinClosed;
}

/** `taigent mcp` did not answer `listProjects` with a result. Setup reports it and exits with ExitCode.Taiga. */
export class McpCheckError extends Error {}

/** The server's command could not start (not on PATH): nothing reached Taiga. Setup reports it with the fix, exit 2. */
export class McpStartError extends Error {}

const CHECK_TIMEOUT_MS = 60_000;
/** taiga-mcp-server 1.9.20: `listProjects` answers an error with this text when the user is in no project. */
const NO_PROJECTS = 'No projects found.';
/** taiga-mcp-server 1.9.20: one line per project of `listProjects`. */
const PROJECT_LINE = /^- .* \(ID: \d+, Slug: .*\)$/gm;

/** The part of an MCP JSON-RPC response the check reads. */
interface McpResponse {
  id?: number;
  result?: { content?: { text?: string }[]; isError?: boolean };
  error?: { message?: string };
}

/**
 * Whether `program` is a file in a directory of `env`'s PATH, as a process start or `cmd /c` finds it (on Windows with
 * an extension of PATHEXT): the check names what is missing instead of reading cmd.exe's localized error.
 */
async function onPath(program: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await access(join(dir, program + extension), constants.X_OK).then(() => true, () => false)) return true;
    }
  }
  return false;
}

/**
 * The MCP check of `taigent setup`: starts the `taiga` server like an agent would, from the command line setup wrote
 * (`command` and `args`, no shell; the `cmd /c` of a Windows entry is its own), in `cwd` with `env`, speaks MCP
 * (JSON-RPC lines) on its stdin/stdout, calls the read tool `listProjects` and returns how many projects it listed.
 * Throws McpStartError when the command (through `cmd /c`, the program it runs) is not on PATH, McpCheckError when the
 * server exits, times out or answers an error.
 */
export async function checkMcp({ command, args, cwd, env }: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }): Promise<{ projects: number }> {
  const shown = [command, ...args].join(' ');
  const notFound = (program: string) => new McpStartError(`cannot start the taiga server (${shown}): ${program} is not on PATH`);
  if (command === 'cmd' && !(await onPath(args[1]!, env))) throw notFound(args[1]!);
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await once(child, 'spawn');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(command);
    throw error;
  }
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  // A server that exited early makes writes fail (EPIPE); `exited` reports it.
  child.stdin.on('error', () => {});
  const exited = once(child, 'close') as Promise<[number | null]>;
  const failure = (message: string) => {
    const output = stderr.trim().split(/\r?\n/).slice(-5).join(' ');
    return new McpCheckError(output ? `${message}: ${output}` : message);
  };
  // Every wait races the server exiting and the deadline.
  const ended = Promise.withResolvers<never>();
  ended.promise.catch(() => {});
  void exited.then(([code]) => ended.reject(failure(`${shown} exited (code ${code}) before answering`)));
  const deadline = setTimeout(() => ended.reject(failure(`${shown} did not answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);

  const pending = new Map<number, (message: McpResponse) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as McpResponse;
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    } catch {
      // Not a JSON-RPC line.
    }
  });
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  let nextId = 1;
  const answer = async (method: string, params: unknown): Promise<McpResponse> => {
    const id = nextId++;
    const reply = Promise.withResolvers<McpResponse>();
    pending.set(id, reply.resolve);
    send({ id, method, params });
    const response = await Promise.race([reply.promise, ended.promise]);
    if (response.error) throw failure(`${shown} refused ${method}: ${response.error.message ?? JSON.stringify(response.error)}`);
    return response;
  };

  try {
    await answer('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'taigent-setup', version: '0' } });
    send({ method: 'notifications/initialized' });
    const { result } = await answer('tools/call', { name: 'listProjects', arguments: {} });
    const text = result?.content?.map((content) => content.text ?? '').join('\n') ?? '';
    if (result?.isError && text.includes(NO_PROJECTS)) return { projects: 0 };
    if (result?.isError || !result?.content) throw new McpCheckError(`listProjects answered an error: ${text || 'no content'}`);
    return { projects: text.match(PROJECT_LINE)?.length ?? 0 };
  } finally {
    clearTimeout(deadline);
    // Closing stdin ends the server like an agent ending its session; one that hangs is killed.
    child.stdin.end();
    const killer = setTimeout(() => child.kill(), 5_000);
    await exited;
    clearTimeout(killer);
  }
}

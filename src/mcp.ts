// `taigent mcp`: starts the Taiga MCP server (taiga-mcp-server, pinned in package.json) in this process, for
// `.mcp.json` / `.codex/config.toml`. taiga-mcp-server only logs in with TAIGA_USERNAME/TAIGA_PASSWORD, so with a
// stored login (or TAIGA_TOKEN) the server talks to a proxy on 127.0.0.1 instead of Taiga:
// - the server gets a random proxy password, never a real one, and the proxy answers its `POST /auth` with the
//   stored user and a proxy token; any other username/password (e.g. the MCP `authenticate` tool) is refused;
// - every other request needs that proxy token and is forwarded to Taiga with the stored login's Authorization
//   header, renewed once on 401.
// With TAIGA_USERNAME and TAIGA_PASSWORD set (environment or .env) the server logs in itself, as before.
// stdout is the MCP channel: everything this module reports goes to stderr.

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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

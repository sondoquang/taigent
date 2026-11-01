// In-process fake of the Taiga REST API (https://docs.taiga.io/api.html).
// It is the single test seam for talking to Taiga: tests point TAIGA_API_URL at
// `fake.url` and assert on `fake.state` afterwards. Extend it (endpoints, hooks)
// instead of mocking internal modules.
//
// Fidelity rules (mirroring taiga-back):
// - Every route lives under /api/v1; everything except POST /auth needs `Authorization: Bearer <token>`.
// - Lists are paginated (30 per page, `x-pagination-*` headers) unless `x-disable-pagination` is sent.
// - Tags are stored lowercased and returned as `[name, color|null]` pairs.
// - Validation errors are 400 with DRF-style `{ field: [message] }` bodies. The fake is STRICTER than
//   Taiga on one point: unknown payload fields are rejected (Taiga silently ignores them), so typos
//   such as `project_id` instead of `project` fail loudly in tests.

import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PAGE_SIZE = 30;

export interface FakeUser {
  id: number;
  username: string;
  password: string;
}

export interface FakeProject {
  id: number;
  slug: string;
  name: string;
  members: number[];
  /** Shared ref sequence for epics/stories/tasks, like Taiga's per-project refs. */
  lastRef: number;
}

export interface FakeEpic {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
}

export interface FakeState {
  users: FakeUser[];
  projects: FakeProject[];
  epics: FakeEpic[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface InterceptRule {
  method: string;
  /** Path below /api/v1, e.g. `/epics` or a RegExp matched against it. */
  path: string | RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** How many matching requests to intercept (default 1). */
  times?: number;
}

export interface FakeTaiga {
  /** Value for TAIGA_API_URL (includes /api/v1, like the real instance). */
  url: string;
  state: FakeState;
  /** Every request received, in order (POST /auth bodies included; do not print them). */
  requests: RecordedRequest[];
  /** Default credentials accepted by POST /auth. */
  user: FakeUser;
  addProject(input: { slug: string; name?: string; members?: number[] }): FakeProject;
  addEpic(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeEpic;
  /** Answer the next matching request(s) with a canned response instead of handling it. */
  intercept(rule: InterceptRule): void;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  readonly reply: Reply;
  constructor(status: number, body: unknown) {
    super(`fake taiga ${status}`);
    this.reply = { status, body };
  }
}

const notFound = () => new HttpError(404, { _error_message: 'No matches the given query.', _error_type: 'taiga.base.exceptions.NotFound' });
const fieldErrors = (errors: Record<string, string[]>) => new HttpError(400, errors);

const EPIC_FIELDS: Record<string, true> = {
  project: true, subject: true, description: true, tags: true, assigned_to: true, status: true, color: true,
  client_requirement: true, team_requirement: true, is_blocked: true, blocked_note: true, epics_order: true,
  watchers: true,
};

export async function startFakeTaiga(): Promise<FakeTaiga> {
  const user: FakeUser = { id: 1, username: 'taigent-bot', password: 'fake-password-123' };
  const state: FakeState = { users: [user], projects: [], epics: [] };
  const requests: RecordedRequest[] = [];
  const intercepts: InterceptRule[] = [];
  const tokens = new Map<string, number>();
  let nextId = 1000;

  function addProject(input: { slug: string; name?: string; members?: number[] }): FakeProject {
    const project: FakeProject = {
      id: ++nextId,
      slug: input.slug,
      name: input.name ?? input.slug,
      members: input.members ?? [user.id],
      lastRef: 0,
    };
    state.projects.push(project);
    return project;
  }

  function addEpic(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeEpic {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const epic: FakeEpic = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
    };
    state.epics.push(epic);
    return epic;
  }

  function epicJson(epic: FakeEpic): Json {
    return { ...epic, tags: epic.tags.map((t) => [t, null]) };
  }

  function projectJson(project: FakeProject, userId: number): Json {
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      i_am_member: project.members.includes(userId),
      is_epics_activated: true,
    };
  }

  function visibleProject(id: unknown, userId: number): FakeProject | undefined {
    return state.projects.find((p) => p.id === id && p.members.includes(userId));
  }

  function paginate(req: IncomingMessage, query: URLSearchParams, items: unknown[]): Reply {
    if (req.headers['x-disable-pagination'] !== undefined) return { status: 200, body: items };
    const page = Number(query.get('page') ?? '1');
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (!Number.isInteger(page) || page < 1 || page > pages) throw notFound();
    const headers: Record<string, string> = {
      'x-paginated': 'true',
      'x-paginated-by': String(PAGE_SIZE),
      'x-pagination-count': String(items.length),
      'x-pagination-current': String(page),
    };
    if (page < pages) headers['x-pagination-next'] = `?page=${page + 1}`;
    return { status: 200, body: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), headers };
  }

  function validateTags(value: unknown): string[] {
    if (!Array.isArray(value)) throw fieldErrors({ tags: ['Expected a list of items.'] });
    return value.map((tag) => {
      if (typeof tag === 'string') return tag;
      if (Array.isArray(tag) && tag.length === 2 && typeof tag[0] === 'string') {
        const color = tag[1];
        if (color === null || color === '' || (typeof color === 'string' && /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(color))) {
          return tag[0];
        }
      }
      throw fieldErrors({ tags: [`Invalid tag '${JSON.stringify(tag)}'. it must be the name or a pair '["name", "hex color/" | null]'.`] });
    });
  }

  function createEpic(body: unknown, userId: number): Reply {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fieldErrors({ non_field_errors: ['Invalid data'] });
    }
    const data = body as Json;
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(data)) {
      if (!Object.hasOwn(EPIC_FIELDS, field)) errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
    }
    if (data.project === undefined) errors.project = ['This field is required.'];
    else if (!Number.isInteger(data.project) || !visibleProject(data.project, userId)) {
      errors.project = [`Invalid pk "${String(data.project)}" - object does not exist.`];
    }
    if (data.subject === undefined) errors.subject = ['This field is required.'];
    else if (typeof data.subject !== 'string' || data.subject.trim() === '') errors.subject = ['This field is required.'];
    else if (data.subject.length > 500) errors.subject = ['Ensure this value has at most 500 characters.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    let tags: string[] = [];
    if (data.tags !== undefined) {
      try {
        tags = validateTags(data.tags);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        Object.assign(errors, error.reply.body);
      }
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const epic = addEpic({
      project: data.project as number,
      subject: data.subject as string,
      description: (data.description as string | undefined) ?? '',
      tags,
    });
    return { status: 201, body: epicJson(epic) };
  }

  function authenticate(req: IncomingMessage): number {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const userId = match ? tokens.get(match[1]!) : undefined;
    if (userId === undefined) {
      throw new HttpError(401, { _error_message: 'Invalid token', _error_type: 'taiga.base.exceptions.NotAuthenticated' });
    }
    return userId;
  }

  function route(req: IncomingMessage, path: string, query: URLSearchParams, body: unknown): Reply {
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/auth') {
      const data = (body ?? {}) as Json;
      if (data.type !== 'normal') throw fieldErrors({ type: ['Invalid auth type'] });
      const found = state.users.find((u) => u.username === data.username && u.password === data.password);
      if (!found) {
        throw new HttpError(401, {
          _error_message: 'No active account found with the given credentials',
          _error_type: 'taiga.base.exceptions.NotAuthenticated',
        });
      }
      const token = `token-${found.id}-${tokens.size + 1}`;
      tokens.set(token, found.id);
      return { status: 200, body: { id: found.id, username: found.username, auth_token: token, refresh: `refresh-${token}` } };
    }

    const userId = authenticate(req);

    if (method === 'GET' && path === '/projects/by_slug') {
      const project = state.projects.find((p) => p.slug === query.get('slug') && p.members.includes(userId));
      if (!project) throw notFound();
      return { status: 200, body: projectJson(project, userId) };
    }

    if (path === '/epics') {
      if (method === 'GET') {
        const projectId = query.has('project') ? Number(query.get('project')) : undefined;
        const epics = state.epics
          .filter((e) => visibleProject(e.project, userId) && (projectId === undefined || e.project === projectId))
          .map(epicJson);
        return paginate(req, query, epics);
      }
      if (method === 'POST') return createEpic(body, userId);
    }

    throw notFound();
  }

  function takeIntercept(method: string, path: string): InterceptRule | undefined {
    const index = intercepts.findIndex(
      (r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    if (index === -1) return undefined;
    const rule = intercepts[index]!;
    rule.times = (rule.times ?? 1) - 1;
    if (rule.times <= 0) intercepts.splice(index, 1);
    return rule;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let reply: Reply;
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const path = url.pathname.startsWith('/api/v1/') ? url.pathname.slice('/api/v1'.length) : undefined;
    const method = req.method ?? 'GET';
    requests.push({ method, path: path ?? url.pathname, query: url.searchParams, headers: req.headers, body });
    try {
      if (path === undefined) throw notFound();
      if (typeof body === 'string') throw new HttpError(400, { _error_message: 'JSON parse error' });
      const rule = takeIntercept(method, path);
      reply = rule ? { status: rule.status, body: rule.body, headers: rule.headers } : route(req, path, url.searchParams, body);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      reply = error.reply;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _error_message: `fake taiga crashed: ${String(error)}` }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    state,
    requests,
    user,
    addProject,
    addEpic,
    intercept: (rule) => void intercepts.push({ ...rule }),
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

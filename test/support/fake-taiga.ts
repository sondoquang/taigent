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
// - PATCH implements OCC like taiga-back: `version` is required, and a stale version is refused with
//   400 {"version": "..."} only when a field in the payload was modified since that version.
// - Epic ↔ story links are unique per (epic, user_story); a duplicate POST is a 400.

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

/** Points estimate: role id → points id ("dictionary of points" in the Taiga API docs). */
export type FakePoints = Record<string, number>;

export interface FakeUserStory {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
  milestone: number | null;
  points: FakePoints;
}

export interface FakeTask {
  id: number;
  ref: number;
  version: number;
  project: number;
  user_story: number | null;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
  milestone: number | null;
}

/** Epic ↔ user story link ("epic related user story detail" in the Taiga API docs). */
export interface FakeEpicRelatedUserStory {
  epic: number;
  user_story: number;
  order: number;
}

export type FakeItem = FakeEpic | FakeUserStory | FakeTask;

export interface FakeState {
  users: FakeUser[];
  projects: FakeProject[];
  epics: FakeEpic[];
  userStories: FakeUserStory[];
  tasks: FakeTask[];
  epicRelatedUserStories: FakeEpicRelatedUserStory[];
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
  /** How many matching requests to let through untouched before intercepting (default 0). */
  after?: number;
  /** How many matching requests to intercept (default 1). */
  times?: number;
}

export interface RequestHook {
  method: string;
  /** Path below /api/v1, or a RegExp matched against it. */
  path: string | RegExp;
  /** Runs right before the fake handles the matching request, e.g. to simulate a concurrent edit. */
  run: () => void;
  /** How many matching requests trigger the hook (default 1). */
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
  addUserStory(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeUserStory;
  addTask(input: { project: number; user_story?: number; subject: string; description?: string; tags?: string[] }): FakeTask;
  addEpicRelatedUserStory(epic: number, userStory: number): FakeEpicRelatedUserStory;
  /** Edits an item like a Taiga user would: bumps `version` and records the fields for OCC checks. */
  editItem<T extends FakeItem>(item: T, changes: Partial<Omit<T, 'id' | 'ref' | 'version' | 'project'>>): void;
  /** Run a callback before the next matching request(s) are handled. */
  onRequest(hook: RequestHook): void;
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

// Create/edit payload fields documented for user stories and tasks (docs.taiga.io/api.html §18.2, §23.2).
const USER_STORY_FIELDS: Record<string, true> = {
  assigned_to: true, backlog_order: true, blocked_note: true, client_requirement: true, description: true,
  is_blocked: true, is_closed: true, kanban_order: true, milestone: true, points: true, project: true,
  sprint_order: true, status: true, subject: true, tags: true, team_requirement: true, watchers: true,
};

const TASK_FIELDS: Record<string, true> = {
  assigned_to: true, blocked_note: true, description: true, is_blocked: true, is_closed: true, milestone: true,
  project: true, user_story: true, status: true, subject: true, tags: true, us_order: true, taskboard_order: true,
  is_iocaine: true, external_reference: true, watchers: true,
};

const RELATED_USER_STORY_FIELDS: Record<string, true> = { epic: true, user_story: true, order: true };

export async function startFakeTaiga(): Promise<FakeTaiga> {
  const user: FakeUser = { id: 1, username: 'taigent-bot', password: 'fake-password-123' };
  const state: FakeState = { users: [user], projects: [], epics: [], userStories: [], tasks: [], epicRelatedUserStories: [] };
  const requests: RecordedRequest[] = [];
  const intercepts: InterceptRule[] = [];
  const hooks: RequestHook[] = [];
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
    const { data, tags } = validateItemPayload(body, EPIC_FIELDS, userId);
    const epic = addEpic({
      project: data.project as number,
      subject: data.subject as string,
      description: (data.description as string | undefined) ?? '',
      tags: tags ?? [],
    });
    return { status: 201, body: epicJson(epic) };
  }

  // --- User stories, tasks, epic ↔ story links, PATCH with OCC (ticket #4) ---

  /** Fields changed by each edit, per item: entry i = fields modified going from version i+1 to i+2. */
  const editHistory = new WeakMap<FakeItem, string[][]>();

  function addUserStory(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeUserStory {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const story: FakeUserStory = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
      milestone: null,
      points: {},
    };
    state.userStories.push(story);
    return story;
  }

  function addTask(input: { project: number; user_story?: number; subject: string; description?: string; tags?: string[] }): FakeTask {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const task: FakeTask = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      user_story: input.user_story ?? null,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
      milestone: null,
    };
    state.tasks.push(task);
    return task;
  }

  function addEpicRelatedUserStory(epic: number, userStory: number): FakeEpicRelatedUserStory {
    const order = state.epicRelatedUserStories.filter((link) => link.epic === epic).length + 1;
    const link: FakeEpicRelatedUserStory = { epic, user_story: userStory, order };
    state.epicRelatedUserStories.push(link);
    return link;
  }

  /** Applies changes, records the fields that really changed and bumps the version, like a Taiga save. */
  function saveEdit(item: FakeItem, changes: Json): void {
    const target = item as unknown as Json;
    const modified: string[] = [];
    for (const [field, value] of Object.entries(changes)) {
      const next = field === 'tags' ? (value as string[]).map((t) => t.toLowerCase()) : value;
      if (JSON.stringify(target[field]) !== JSON.stringify(next)) modified.push(field);
      target[field] = next;
    }
    editHistory.set(item, [...(editHistory.get(item) ?? []), modified]);
    item.version += 1;
  }

  function editItem<T extends FakeItem>(item: T, changes: Partial<Omit<T, 'id' | 'ref' | 'version' | 'project'>>): void {
    saveEdit(item, changes as Json);
  }

  /**
   * Validates a create (POST, no `existing`) or edit (PATCH) payload of an epic, user story or task.
   * Required fields only apply to creation; `version` only to edits.
   */
  function validateItemPayload(body: unknown, allowed: Record<string, true>, userId: number, existing?: FakeItem): { data: Json; tags: string[] | undefined } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fieldErrors({ non_field_errors: ['Invalid data'] });
    }
    const data = body as Json;
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(data)) {
      if (!Object.hasOwn(allowed, field) && !(existing && field === 'version')) {
        errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
      }
    }
    if (data.project === undefined) {
      if (!existing) errors.project = ['This field is required.'];
    } else if (!Number.isInteger(data.project) || !visibleProject(data.project, userId)) {
      errors.project = [`Invalid pk "${String(data.project)}" - object does not exist.`];
    }
    if (data.subject === undefined) {
      if (!existing) errors.subject = ['This field is required.'];
    } else if (typeof data.subject !== 'string' || data.subject.trim() === '') errors.subject = ['This field is required.'];
    else if (data.subject.length > 500) errors.subject = ['Ensure this value has at most 500 characters.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    const points = data.points;
    if (points !== undefined && (typeof points !== 'object' || points === null || Array.isArray(points) || !Object.values(points).every(Number.isInteger))) {
      errors.points = ['Points must be a dictionary of role id → points id (fake wording).'];
    }
    if (data.user_story !== undefined && data.user_story !== null) {
      const projectId = existing?.project ?? data.project;
      if (!state.userStories.some((s) => s.id === data.user_story && s.project === projectId)) {
        errors.user_story = [`Invalid pk "${String(data.user_story)}" - object does not exist.`];
      }
    }
    let tags: string[] | undefined;
    if (data.tags !== undefined) {
      try {
        tags = validateTags(data.tags);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        Object.assign(errors, error.reply.body);
      }
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    return { data, tags };
  }

  /** Taiga OCC (docs §1.2, taiga-back OCCResourceMixin): stale versions only fail when the same fields changed. */
  function checkVersion(item: FakeItem, data: Json): void {
    const raw = data.version;
    if (raw !== undefined && raw !== null && !Number.isInteger(raw)) {
      throw new HttpError(400, { version: 'The version must be an integer' });
    }
    const version = (raw ?? null) as number | null;
    if (version === null || version < 0 || version > item.version) {
      throw new HttpError(400, { version: 'The version parameter is not valid' });
    }
    if (version === item.version) return;
    const history = editHistory.get(item) ?? [];
    const modified = new Set(history.slice(Math.max(0, history.length - (item.version - version))).flat());
    if (Object.keys(data).some((field) => field !== 'version' && modified.has(field))) {
      throw new HttpError(400, { version: "The version doesn't match with the current one" });
    }
  }

  function patchItem(item: FakeItem, body: unknown, allowed: Record<string, true>, userId: number): Json {
    const { data, tags } = validateItemPayload(body, allowed, userId, item);
    checkVersion(item, data);
    const { version: _version, ...changes } = data;
    if (tags !== undefined) changes.tags = tags;
    saveEdit(item, changes);
    return itemJson(item);
  }

  function itemJson(item: FakeItem): Json {
    return { ...item, tags: item.tags.map((t) => [t, null]) };
  }

  /** Taiga's `tags=a,b` list filter keeps items carrying every listed tag. */
  function hasTags(item: FakeItem, query: URLSearchParams): boolean {
    const wanted = query.get('tags');
    if (!wanted) return true;
    return wanted.split(',').every((tag) => item.tags.includes(tag.trim().toLowerCase()));
  }

  function queryNumber(query: URLSearchParams, name: string): number | undefined {
    return query.has(name) ? Number(query.get(name)) : undefined;
  }

  function routeStoriesAndTasks(req: IncomingMessage, method: string, path: string, query: URLSearchParams, body: unknown, userId: number): Reply | undefined {
    if (path === '/userstories') {
      if (method === 'GET') {
        const projectId = queryNumber(query, 'project');
        const stories = state.userStories.filter(
          (s) => visibleProject(s.project, userId) && (projectId === undefined || s.project === projectId) && hasTags(s, query),
        );
        return paginate(req, query, stories.map(itemJson));
      }
      if (method === 'POST') {
        const { data, tags } = validateItemPayload(body, USER_STORY_FIELDS, userId);
        const story = addUserStory({
          project: data.project as number,
          subject: data.subject as string,
          description: (data.description as string | undefined) ?? '',
          tags: tags ?? [],
        });
        for (const field of ['status', 'assigned_to', 'milestone', 'points'] as const) {
          if (data[field] !== undefined) (story as unknown as Json)[field] = data[field];
        }
        return { status: 201, body: itemJson(story) };
      }
    }

    if (path === '/tasks') {
      if (method === 'GET') {
        const projectId = queryNumber(query, 'project');
        const storyId = queryNumber(query, 'user_story');
        const tasks = state.tasks.filter(
          (task) =>
            visibleProject(task.project, userId) &&
            (projectId === undefined || task.project === projectId) &&
            (storyId === undefined || task.user_story === storyId) &&
            hasTags(task, query),
        );
        return paginate(req, query, tasks.map(itemJson));
      }
      if (method === 'POST') {
        const { data, tags } = validateItemPayload(body, TASK_FIELDS, userId);
        const task = addTask({
          project: data.project as number,
          user_story: (data.user_story as number | null | undefined) ?? undefined,
          subject: data.subject as string,
          description: (data.description as string | undefined) ?? '',
          tags: tags ?? [],
        });
        for (const field of ['status', 'assigned_to', 'milestone'] as const) {
          if (data[field] !== undefined) (task as unknown as Json)[field] = data[field];
        }
        return { status: 201, body: itemJson(task) };
      }
    }

    const itemPath = /^\/(epics|userstories|tasks)\/(\d+)$/.exec(path);
    if (itemPath && method === 'PATCH') {
      const id = Number(itemPath[2]);
      const [items, allowed] =
        itemPath[1] === 'epics' ? [state.epics, EPIC_FIELDS] : itemPath[1] === 'userstories' ? [state.userStories, USER_STORY_FIELDS] : [state.tasks, TASK_FIELDS];
      const item = (items as FakeItem[]).find((i) => i.id === id && visibleProject(i.project, userId));
      if (!item) throw notFound();
      return { status: 200, body: patchItem(item, body, allowed, userId) };
    }

    const related = /^\/epics\/(\d+)\/related_userstories$/.exec(path);
    if (related) {
      const epic = state.epics.find((e) => e.id === Number(related[1]) && visibleProject(e.project, userId));
      if (!epic) throw notFound();
      if (method === 'GET') {
        return paginate(req, query, state.epicRelatedUserStories.filter((link) => link.epic === epic.id));
      }
      if (method === 'POST') {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fieldErrors({ non_field_errors: ['Invalid data'] });
        const data = body as Json;
        const errors: Record<string, string[]> = {};
        for (const field of Object.keys(data)) {
          if (!Object.hasOwn(RELATED_USER_STORY_FIELDS, field)) errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
        }
        if (data.epic === undefined) errors.epic = ['This field is required.'];
        else if (data.epic !== epic.id) errors.epic = [`Invalid pk "${String(data.epic)}" - must be the epic of the URL (fake wording).`];
        if (data.user_story === undefined) errors.user_story = ['This field is required.'];
        else if (!state.userStories.some((s) => s.id === data.user_story && visibleProject(s.project, userId))) {
          errors.user_story = [`Invalid pk "${String(data.user_story)}" - object does not exist.`];
        }
        if (Object.keys(errors).length > 0) throw fieldErrors(errors);
        if (state.epicRelatedUserStories.some((link) => link.epic === epic.id && link.user_story === data.user_story)) {
          throw fieldErrors({ non_field_errors: ['The fields user_story, epic must make a unique set.'] });
        }
        return { status: 201, body: addEpicRelatedUserStory(epic.id, data.user_story as number) };
      }
    }

    return undefined;
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

    const reply = routeStoriesAndTasks(req, method, path, query, body, userId);
    if (reply) return reply;
    throw notFound();
  }

  function takeIntercept(method: string, path: string): InterceptRule | undefined {
    const index = intercepts.findIndex(
      (r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    if (index === -1) return undefined;
    const rule = intercepts[index]!;
    if ((rule.after ?? 0) > 0) {
      rule.after! -= 1;
      return undefined;
    }
    rule.times = (rule.times ?? 1) - 1;
    if (rule.times <= 0) intercepts.splice(index, 1);
    return rule;
  }

  function runHooks(method: string, path: string): void {
    for (const hook of [...hooks]) {
      if (hook.method !== method || !(typeof hook.path === 'string' ? hook.path === path : hook.path.test(path))) continue;
      hook.times = (hook.times ?? 1) - 1;
      if (hook.times <= 0) hooks.splice(hooks.indexOf(hook), 1);
      hook.run();
    }
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
      runHooks(method, path);
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
    addUserStory,
    addTask,
    addEpicRelatedUserStory,
    editItem,
    onRequest: (hook) => void hooks.push({ ...hook }),
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

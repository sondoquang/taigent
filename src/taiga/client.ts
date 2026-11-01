// Taiga client: owns all HTTP to the Taiga REST API (https://docs.taiga.io/api.html).
// Knows Taiga endpoints only, never manifests. Every request disables pagination.

import { errorMessage, isRecord } from '../guards.ts';

/** Thrown for any Taiga/network failure. Maps to ExitCode.Taiga. Never contains credentials. */
export class TaigaError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TaigaError';
    this.status = status;
  }
}

export interface TaigaCredentials {
  /** Base API URL including `/api/v1`, as in TAIGA_API_URL. */
  apiUrl: string;
  username: string;
  password: string;
}

export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
}

export interface TaigaEpic {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  /** Tag names (Taiga stores them lowercased). */
  tags: string[];
}

export interface NewEpic {
  project: number;
  subject: string;
  description: string;
  tags: string[];
}

interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
}

const MAX_ERROR_BODY = 500;

function field<T>(raw: Record<string, unknown>, name: string, type: 'number' | 'string', what: string): T {
  const value = raw[name];
  if (typeof value !== type) throw new TaigaError(`unexpected Taiga response: ${what}.${name} is not a ${type}`);
  return value as T;
}

function parseEpic(raw: unknown): TaigaEpic {
  if (!isRecord(raw)) throw new TaigaError('unexpected Taiga response: epic is not an object');
  // Taiga returns tags as [name, color|null] pairs.
  const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => String(Array.isArray(tag) ? tag[0] : tag)) : [];
  return {
    id: field(raw, 'id', 'number', 'epic'),
    ref: field(raw, 'ref', 'number', 'epic'),
    version: field(raw, 'version', 'number', 'epic'),
    project: field(raw, 'project', 'number', 'epic'),
    subject: field(raw, 'subject', 'string', 'epic'),
    description: typeof raw.description === 'string' ? raw.description : '',
    tags,
  };
}

// ---- Bootstrap types (project configuration) ------------------------------------------------------

/** Project module flags, as in `PATCH /projects/{id}`. */
export const MODULE_FLAGS = ['is_epics_activated', 'is_backlog_activated', 'is_kanban_activated', 'is_issues_activated', 'is_wiki_activated'] as const;
export type ModuleFlag = (typeof MODULE_FLAGS)[number];

export type CustomAttributeItemType = 'epic' | 'userstory' | 'task';

export interface TaigaUser {
  id: number;
  username: string;
  email: string | null;
}

export interface TaigaRole {
  id: number;
  name: string;
  slug: string;
}

export interface TaigaProjectTemplate {
  id: number;
  name: string;
  slug: string;
  modules: Record<ModuleFlag, boolean>;
  /** Roles a project created from the template gets (no ids yet). */
  roles: { name: string; slug: string }[];
}

export interface TaigaCustomAttribute {
  id: number;
  name: string;
}

export interface TaigaProjectDetail {
  id: number;
  slug: string;
  name: string;
  iAmAdmin: boolean;
  modules: Record<ModuleFlag, boolean>;
  /** Tag → color (null when the tag has no color), including tags only used by items. */
  tagsColors: Record<string, string | null>;
  roles: TaigaRole[];
  /** Active members (accepted memberships). */
  members: { id: number; username: string }[];
  customAttributes: Record<CustomAttributeItemType, TaigaCustomAttribute[]>;
}

export interface TaigaMembership {
  id: number;
  role: number;
  /** Null for a pending invitation. */
  user: number | null;
  /** E-mail the invitation was sent to. */
  email: string | null;
  /** E-mail of the member's account. */
  userEmail: string | null;
}

export interface NewProject {
  name: string;
  description: string;
  creation_template: number;
  is_private: boolean;
}

export interface NewCustomAttribute {
  project: number;
  name: string;
  description: string;
  type: string;
}

export interface NewMembership {
  project: number;
  role: number;
  /** Username or e-mail. */
  username: string;
}

function record(raw: unknown, what: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new TaigaError(`unexpected Taiga response: ${what} is not an object`);
  return raw;
}

function list(raw: unknown, what: string): unknown[] {
  if (!Array.isArray(raw)) throw new TaigaError(`unexpected Taiga response: ${what} is not an array`);
  return raw;
}

function parseModules(raw: Record<string, unknown>): Record<ModuleFlag, boolean> {
  return Object.fromEntries(MODULE_FLAGS.map((flag) => [flag, raw[flag] === true])) as Record<ModuleFlag, boolean>;
}

function parseCustomAttribute(raw: unknown): TaigaCustomAttribute {
  const r = record(raw, 'custom attribute');
  return { id: field(r, 'id', 'number', 'custom attribute'), name: field(r, 'name', 'string', 'custom attribute') };
}

function parseProjectDetail(raw: unknown): TaigaProjectDetail {
  const r = record(raw, 'project');
  const tagsColors: Record<string, string | null> = {};
  // Taiga serializes tags_colors as an object; accept [name, color] pairs too.
  const rawColors = r.tags_colors ?? {};
  for (const [tag, color] of Array.isArray(rawColors) ? (rawColors as [string, unknown][]) : Object.entries(record(rawColors, 'tags_colors'))) {
    tagsColors[tag] = typeof color === 'string' && color !== '' ? color : null;
  }
  return {
    id: field(r, 'id', 'number', 'project'),
    slug: field(r, 'slug', 'string', 'project'),
    name: field(r, 'name', 'string', 'project'),
    iAmAdmin: r.i_am_admin === true,
    modules: parseModules(r),
    tagsColors,
    roles: list(r.roles ?? [], 'project roles').map((role) => {
      const x = record(role, 'role');
      return { id: field(x, 'id', 'number', 'role'), name: field(x, 'name', 'string', 'role'), slug: field(x, 'slug', 'string', 'role') };
    }),
    members: list(r.members ?? [], 'project members').map((member) => {
      const x = record(member, 'member');
      return { id: field(x, 'id', 'number', 'member'), username: field(x, 'username', 'string', 'member') };
    }),
    customAttributes: {
      epic: list(r.epic_custom_attributes ?? [], 'epic custom attributes').map(parseCustomAttribute),
      userstory: list(r.userstory_custom_attributes ?? [], 'user story custom attributes').map(parseCustomAttribute),
      task: list(r.task_custom_attributes ?? [], 'task custom attributes').map(parseCustomAttribute),
    },
  };
}

function parseMembership(raw: unknown): TaigaMembership {
  const r = record(raw, 'membership');
  return {
    id: field(r, 'id', 'number', 'membership'),
    role: field(r, 'role', 'number', 'membership'),
    user: typeof r.user === 'number' ? r.user : null,
    email: typeof r.email === 'string' ? r.email : null,
    userEmail: typeof r.user_email === 'string' ? r.user_email : null,
  };
}

export class TaigaClient {
  readonly apiUrl: string;
  readonly #token: string;

  private constructor(apiUrl: string, token: string) {
    this.apiUrl = apiUrl;
    this.#token = token;
  }

  /** Logs in with username/password (`POST /auth`, type `normal`). */
  static async login(credentials: TaigaCredentials): Promise<TaigaClient> {
    const apiUrl = credentials.apiUrl.replace(/\/+$/, '');
    const anonymous = new TaigaClient(apiUrl, '');
    const auth = await anonymous.#request('POST', '/auth', {
      body: { type: 'normal', username: credentials.username, password: credentials.password },
    });
    if (!isRecord(auth) || typeof auth.auth_token !== 'string') {
      throw new TaigaError(`login to ${apiUrl} failed: response has no auth_token`);
    }
    return new TaigaClient(apiUrl, auth.auth_token);
  }

  async getProjectBySlug(slug: string): Promise<TaigaProject> {
    let raw: unknown;
    try {
      raw = await this.#request('GET', '/projects/by_slug', { query: { slug } });
    } catch (error) {
      if (error instanceof TaigaError && error.status === 404) {
        throw new TaigaError(`project "${slug}" not found on ${this.apiUrl} (or not visible to this user)`, 404);
      }
      throw error;
    }
    if (!isRecord(raw)) throw new TaigaError('unexpected Taiga response: project is not an object');
    return {
      id: field(raw, 'id', 'number', 'project'),
      slug: field(raw, 'slug', 'string', 'project'),
      name: field(raw, 'name', 'string', 'project'),
    };
  }

  /** All epics of a project (Taiga's epic list has no documented tag filter, so filter client-side). */
  async listEpics(projectId: number): Promise<TaigaEpic[]> {
    const raw = await this.#request('GET', '/epics', { query: { project: projectId } });
    if (!Array.isArray(raw)) throw new TaigaError('unexpected Taiga response: epic list is not an array');
    return raw.map(parseEpic);
  }

  async createEpic(epic: NewEpic): Promise<TaigaEpic> {
    return parseEpic(await this.#request('POST', '/epics', { body: epic }));
  }

  // ---- Bootstrap: user, templates, project configuration, memberships, wiki ----------------------

  /** The authenticated user (`GET /users/me`). */
  async getMe(): Promise<TaigaUser> {
    const raw = record(await this.#request('GET', '/users/me'), 'user');
    return {
      id: field(raw, 'id', 'number', 'user'),
      username: field(raw, 'username', 'string', 'user'),
      email: typeof raw.email === 'string' ? raw.email : null,
    };
  }

  async listProjectTemplates(): Promise<TaigaProjectTemplate[]> {
    return list(await this.#request('GET', '/project-templates'), 'project template list').map((item) => {
      const raw = record(item, 'project template');
      return {
        id: field(raw, 'id', 'number', 'project template'),
        name: field(raw, 'name', 'string', 'project template'),
        slug: field(raw, 'slug', 'string', 'project template'),
        modules: parseModules(raw),
        roles: list(raw.roles ?? [], 'project template roles').map((role) => {
          const r = record(role, 'role');
          return { name: field(r, 'name', 'string', 'role'), slug: field(r, 'slug', 'string', 'role') };
        }),
      };
    });
  }

  /** Project detail by slug, or undefined when no project with that slug is visible to the user. */
  async findProjectBySlug(slug: string): Promise<TaigaProjectDetail | undefined> {
    const raw = await this.#find('GET', '/projects/by_slug', { query: { slug } });
    return raw === undefined ? undefined : parseProjectDetail(raw);
  }

  /** Project detail by id, or undefined when it does not exist or is not visible. */
  async findProject(id: number): Promise<TaigaProjectDetail | undefined> {
    const raw = await this.#find('GET', `/projects/${id}`);
    return raw === undefined ? undefined : parseProjectDetail(raw);
  }

  /** `POST /projects`; Taiga derives the slug from the name (it is read-only). */
  async createProject(project: NewProject): Promise<TaigaProjectDetail> {
    return parseProjectDetail(await this.#request('POST', '/projects', { body: project }));
  }

  /** Enables/disables modules (`PATCH /projects/{id}`). */
  async updateProjectModules(projectId: number, modules: Partial<Record<ModuleFlag, boolean>>): Promise<TaigaProjectDetail> {
    return parseProjectDetail(await this.#request('PATCH', `/projects/${projectId}`, { body: modules }));
  }

  async createTag(projectId: number, tag: string, color: string): Promise<void> {
    await this.#request('POST', `/projects/${projectId}/create_tag`, { body: { tag, color } });
  }

  async setTagColor(projectId: number, tag: string, color: string): Promise<void> {
    await this.#request('POST', `/projects/${projectId}/edit_tag`, { body: { from_tag: tag, color } });
  }

  async createCustomAttribute(itemType: CustomAttributeItemType, attribute: NewCustomAttribute): Promise<TaigaCustomAttribute> {
    return parseCustomAttribute(await this.#request('POST', `/${itemType}-custom-attributes`, { body: attribute }));
  }

  async listMemberships(projectId: number): Promise<TaigaMembership[]> {
    return list(await this.#request('GET', '/memberships', { query: { project: projectId } }), 'membership list').map(parseMembership);
  }

  /** Invites a user by username or e-mail (`POST /memberships`). */
  async createMembership(membership: NewMembership): Promise<TaigaMembership> {
    return parseMembership(await this.#request('POST', '/memberships', { body: membership }));
  }

  /** Wiki page id by slug, or undefined when the page does not exist. */
  async findWikiPage(projectId: number, slug: string): Promise<{ id: number } | undefined> {
    const raw = await this.#find('GET', '/wiki/by_slug', { query: { slug, project: projectId } });
    return raw === undefined ? undefined : { id: field(record(raw, 'wiki page'), 'id', 'number', 'wiki page') };
  }

  async createWikiPage(page: { project: number; slug: string; content: string }): Promise<{ id: number }> {
    return { id: field(record(await this.#request('POST', '/wiki', { body: page }), 'wiki page'), 'id', 'number', 'wiki page') };
  }

  /** Like #request, but a 404 means "absent" and returns undefined. */
  async #find(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    try {
      return await this.#request(method, path, options);
    } catch (error) {
      if (error instanceof TaigaError && error.status === 404) return undefined;
      throw error;
    }
  }

  async #request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(this.apiUrl + path);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { accept: 'application/json', 'x-disable-pagination': 'True' };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      // fetch() reports the real reason (ECONNREFUSED, DNS failure, ...) as the error's cause.
      const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
      throw new TaigaError(`cannot reach Taiga at ${this.apiUrl}: ${errorMessage(reason)}`);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
      throw new TaigaError(`${method} ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`, response.status);
    }
    if (text === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new TaigaError(`${method} ${path}: Taiga returned a non-JSON response`, response.status);
    }
  }
}

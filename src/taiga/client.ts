// Taiga client: owns all HTTP to the Taiga REST API (https://docs.taiga.io/api.html).
// Knows Taiga endpoints only, never manifests. Every request disables pagination, renews the access
// token once on 401 (`/auth/refresh`, else a new login) and backs off on 429.

import { setTimeout as sleep } from 'node:timers/promises';
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

/** A PATCH was refused because the item changed on Taiga since its `version` was read (OCC). */
export class TaigaConflictError extends TaigaError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'TaigaConflictError';
  }
}

/** Which secret Taiga rejected; lets the CLI name the variable to check. */
export type TaigaCredentialKind = 'token' | 'password';

/** Authentication failed and could not be recovered (login refused, or a token that can't be renewed). */
export class TaigaAuthError extends TaigaError {
  readonly credential: TaigaCredentialKind;

  constructor(credential: TaigaCredentialKind, message: string, status?: number) {
    super(message, status);
    this.name = 'TaigaAuthError';
    this.credential = credential;
  }
}

export interface TaigaConnectOptions {
  /** Base API URL including `/api/v1`, as in TAIGA_API_URL. */
  apiUrl: string;
  /** Access token used as-is (no login). Without it, `credentials` are required. */
  token?: string;
  /** Username/password for `POST /auth`; also used to log in again when a token can't be refreshed. */
  credentials?: { username: string; password: string };
  /** Milliseconds per second of 429 backoff (default 1000); tests shrink it. */
  retryUnitMs?: number;
}

export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
}

/** Common shape of epics, user stories and tasks. */
export interface TaigaItem {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  /** Tag names (Taiga stores them lowercased). */
  tags: string[];
}

export interface TaigaTask extends TaigaItem {
  /** Parent user story id, null for a task outside any story. */
  userStory: number | null;
}

export interface NewItem {
  project: number;
  subject: string;
  description: string;
  tags: string[];
}

export interface NewTask extends NewItem {
  user_story: number;
}

/** Manifest-managed fields an update may change; everything else on the item is left alone. */
export type ItemPatch = Partial<Pick<TaigaItem, 'subject' | 'description' | 'tags'>>;

interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
  /** On 401, renew the token and retry once (default true; off for the auth endpoints themselves). */
  reauthenticate?: boolean;
}

interface RawResponse {
  status: number;
  ok: boolean;
  retryAfter: string | null;
  text: string;
}

const MAX_ERROR_BODY = 500;
/** 429 handling: retries per request, and the longest single wait, in backoff units (seconds by default). */
const MAX_THROTTLE_RETRIES = 5;
const MAX_BACKOFF_UNITS = 60;
const REDACTED = '[redacted]';

function field<T>(raw: Record<string, unknown>, name: string, type: 'number' | 'string', what: string): T {
  const value = raw[name];
  if (typeof value !== type) throw new TaigaError(`unexpected Taiga response: ${what}.${name} is not a ${type}`);
  return value as T;
}

function parseItem(raw: unknown, what: string): TaigaItem {
  if (!isRecord(raw)) throw new TaigaError(`unexpected Taiga response: ${what} is not an object`);
  // Taiga returns tags as [name, color|null] pairs.
  const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => String(Array.isArray(tag) ? tag[0] : tag)) : [];
  return {
    id: field(raw, 'id', 'number', what),
    ref: field(raw, 'ref', 'number', what),
    version: field(raw, 'version', 'number', what),
    project: field(raw, 'project', 'number', what),
    subject: field(raw, 'subject', 'string', what),
    description: typeof raw.description === 'string' ? raw.description : '',
    tags,
  };
}

function parseTask(raw: unknown): TaigaTask {
  const task = parseItem(raw, 'task');
  const userStory = isRecord(raw) && typeof raw.user_story === 'number' ? raw.user_story : null;
  return { ...task, userStory };
}

function parseList<T>(raw: unknown, what: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw new TaigaError(`unexpected Taiga response: ${what} list is not an array`);
  return raw.map(parse);
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
  readonly #credentials: TaigaConnectOptions['credentials'];
  readonly #retryUnitMs: number;
  #token: string | undefined;
  #refresh: string | undefined;
  /** Every secret this client has held; redacted from error messages in case Taiga echoes one back. */
  readonly #secrets = new Set<string>();

  private constructor(options: TaigaConnectOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.#credentials = options.credentials;
    this.#retryUnitMs = options.retryUnitMs ?? 1000;
    if (options.credentials) this.#secrets.add(options.credentials.password);
    if (options.token) this.#setTokens(options.token, undefined);
  }

  /** Uses `token` as-is, or logs in with `credentials` (`POST /auth`, type `normal`). */
  static async connect(options: TaigaConnectOptions): Promise<TaigaClient> {
    const client = new TaigaClient(options);
    if (client.#token === undefined) {
      if (!client.#credentials) throw new TypeError('TaigaClient.connect needs a token or credentials');
      await client.#login();
    }
    return client;
  }

  #setTokens(token: string, refresh: string | undefined): void {
    this.#token = token;
    this.#refresh = refresh;
    this.#secrets.add(token);
    if (refresh !== undefined) this.#secrets.add(refresh);
  }

  /** Takes `auth_token`/`refresh` from a `/auth` or `/auth/refresh` response. */
  #adoptTokens(raw: unknown, what: string): void {
    if (!isRecord(raw) || typeof raw.auth_token !== 'string') {
      throw new TaigaError(`${what} at ${this.apiUrl} failed: response has no auth_token`);
    }
    this.#setTokens(raw.auth_token, typeof raw.refresh === 'string' ? raw.refresh : undefined);
  }

  async #login(): Promise<void> {
    const { username, password } = this.#credentials!;
    let auth: unknown;
    try {
      auth = await this.#request('POST', '/auth', { body: { type: 'normal', username, password }, reauthenticate: false });
    } catch (error) {
      // Taiga refuses bad credentials with 401 (400 in older versions); anything else is not about them.
      if (error instanceof TaigaError && (error.status === 400 || error.status === 401)) {
        throw new TaigaAuthError('password', `login to ${this.apiUrl} failed: ${error.message}`, error.status);
      }
      throw error;
    }
    this.#adoptTokens(auth, 'login');
  }

  /** After a 401: refresh the token (`POST /auth/refresh`), else log in again. False when neither is possible. */
  async #renewToken(): Promise<boolean> {
    if (this.#refresh !== undefined) {
      try {
        const raw = await this.#request('POST', '/auth/refresh', { body: { refresh: this.#refresh }, reauthenticate: false });
        this.#adoptTokens(raw, 'token refresh');
        return true;
      } catch (error) {
        // An expired or revoked refresh token: fall back to logging in again.
        if (!(error instanceof TaigaError) || error.status === undefined || !this.#credentials) throw error;
      }
    }
    if (!this.#credentials) return false;
    await this.#login();
    return true;
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
  async listEpics(projectId: number): Promise<TaigaItem[]> {
    const raw = await this.#request('GET', '/epics', { query: { project: projectId } });
    return parseList(raw, 'epic', (item) => parseItem(item, 'epic'));
  }

  async createEpic(epic: NewItem): Promise<TaigaItem> {
    return parseItem(await this.#request('POST', '/epics', { body: epic }), 'epic');
  }

  /** All user stories of a project (every `src:` tag is needed to find orphans, so no tag filter). */
  async listUserStories(projectId: number): Promise<TaigaItem[]> {
    const raw = await this.#request('GET', '/userstories', { query: { project: projectId } });
    return parseList(raw, 'user story', (item) => parseItem(item, 'user story'));
  }

  async createUserStory(story: NewItem): Promise<TaigaItem> {
    return parseItem(await this.#request('POST', '/userstories', { body: story }), 'user story');
  }

  /** All tasks of a project. */
  async listTasks(projectId: number): Promise<TaigaTask[]> {
    return parseList(await this.#request('GET', '/tasks', { query: { project: projectId } }), 'task', parseTask);
  }

  async createTask(task: NewTask): Promise<TaigaTask> {
    return parseTask(await this.#request('POST', '/tasks', { body: task }));
  }

  /** Ids of the user stories linked to an epic (`GET /epics/{id}/related_userstories`). */
  async listEpicUserStories(epicId: number): Promise<number[]> {
    const raw = await this.#request('GET', `/epics/${epicId}/related_userstories`);
    return parseList(raw, 'related user story', (link) => field<number>(isRecord(link) ? link : {}, 'user_story', 'number', 'related user story'));
  }

  /** Links a user story to an epic. The broken MCP `linkStoryToEpic` PATCHes the story instead. */
  async linkEpicUserStory(epicId: number, userStoryId: number): Promise<void> {
    await this.#request('POST', `/epics/${epicId}/related_userstories`, { body: { epic: epicId, user_story: userStoryId } });
  }

  async updateEpic(id: number, patch: ItemPatch, version: number): Promise<TaigaItem> {
    return parseItem(await this.#patch(`/epics/${id}`, patch, version), 'epic');
  }

  async updateUserStory(id: number, patch: ItemPatch, version: number): Promise<TaigaItem> {
    return parseItem(await this.#patch(`/userstories/${id}`, patch, version), 'user story');
  }

  async updateTask(id: number, patch: ItemPatch, version: number): Promise<TaigaTask> {
    return parseTask(await this.#patch(`/tasks/${id}`, patch, version));
  }

  /** PATCH with the item's `version` (OCC); a stale version becomes a TaigaConflictError. */
  async #patch(path: string, patch: ItemPatch, version: number): Promise<unknown> {
    try {
      return await this.#request('PATCH', path, { body: { ...patch, version } });
    } catch (error) {
      // taiga-back answers 400 {"version": "..."} for a stale or invalid version.
      if (error instanceof TaigaError && error.status === 400 && /"version"\s*:/.test(error.message)) {
        throw new TaigaConflictError(`version ${version} is stale: the item was changed on Taiga meanwhile`);
      }
      throw error;
    }
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

  /** One API call: renews the token and retries once on 401, backs off and retries on 429. */
  async #request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    let renewed = false;
    for (let throttled = 0; ; ) {
      const response = await this.#send(method, path, options);
      if (response.status === 429 && throttled < MAX_THROTTLE_RETRIES) {
        await sleep(this.#backoffMs(response.retryAfter, throttled++));
        continue;
      }
      if (response.status === 401 && options.reauthenticate !== false) {
        if (!renewed && (await this.#renewToken())) {
          renewed = true;
          continue;
        }
        throw new TaigaAuthError(
          this.#credentials ? 'password' : 'token',
          `Taiga at ${this.apiUrl} rejected the access token: ${this.#failure(method, path, response)}`,
          response.status,
        );
      }
      if (!response.ok) {
        const suffix = response.status === 429 ? ` (still throttled after ${MAX_THROTTLE_RETRIES} retries)` : '';
        throw new TaigaError(`${this.#failure(method, path, response)}${suffix}`, response.status);
      }
      if (response.text === '') return undefined;
      try {
        return JSON.parse(response.text);
      } catch {
        throw new TaigaError(`${method} ${path}: Taiga returned a non-JSON response`, response.status);
      }
    }
  }

  async #send(method: string, path: string, options: RequestOptions): Promise<RawResponse> {
    const url = new URL(this.apiUrl + path);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = { accept: 'application/json', 'x-disable-pagination': 'True' };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, retryAfter: response.headers.get('retry-after'), text };
    } catch (error) {
      // fetch() reports the real reason (ECONNREFUSED, DNS failure, ...) as the error's cause.
      const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
      throw new TaigaError(this.#redact(`cannot reach Taiga at ${this.apiUrl}: ${errorMessage(reason)}`));
    }
  }

  /** `METHOD /path failed: HTTP <status> <body>`, with any secret Taiga echoed redacted (before truncating). */
  #failure(method: string, path: string, response: RawResponse): string {
    const text = this.#redact(response.text);
    const detail = text.length > MAX_ERROR_BODY ? `${text.slice(0, MAX_ERROR_BODY)}…` : text;
    return `${method} ${path} failed: HTTP ${response.status}${detail ? ` ${detail}` : ''}`;
  }

  /** Wait before retrying a 429: `Retry-After` (seconds or HTTP date) when given, else 1, 2, 4… units; capped. */
  #backoffMs(retryAfter: string | null, attempt: number): number {
    let units = 2 ** attempt;
    if (retryAfter !== null && retryAfter.trim() !== '') {
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(seconds)) units = seconds;
      else if (!Number.isNaN(date)) units = (date - Date.now()) / 1000;
    }
    return Math.min(Math.max(units, 0), MAX_BACKOFF_UNITS) * this.#retryUnitMs;
  }

  #redact(text: string): string {
    let result = text;
    // Longest first, so a secret containing another one is replaced whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      if (secret !== '') result = result.replaceAll(secret, REDACTED);
    }
    return result;
  }
}

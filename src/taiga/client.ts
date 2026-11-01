// Taiga client: owns all HTTP to the Taiga REST API (https://docs.taiga.io/api.html).
// Knows Taiga endpoints only, never manifests. Every request disables pagination, renews the access
// token once on 401 (`/auth/refresh`, else a new login) and backs off on 429.

import { openAsBlob } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, isRecord } from '../guards.ts';
import { ITEM_TYPES, type ItemType } from '../items.ts';
import { Secrets } from '../secrets.ts';

/** Thrown for any Taiga/network failure. Maps to ExitCode.Taiga. Never contains credentials. */
export class TaigaError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TaigaError';
    this.status = status;
  }
}

/**
 * A PATCH was refused because the object changed on Taiga since its `version` was read (OCC). The client throws it
 * without a key; the command that planned the write rethrows it with `key` naming what conflicted (an item key, or
 * `wiki:<slug>`), which the CLI reports.
 */
export class TaigaConflictError extends TaigaError {
  readonly key: string | undefined;

  constructor(message: string, key?: string) {
    super(message, 400);
    this.name = 'TaigaConflictError';
    this.key = key;
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
  /**
   * Where the client registers every secret it holds (password, tokens), redacted from its error messages in case
   * Taiga echoes one back. The CLI passes its own, so its output redacts tokens the client obtained too.
   */
  secrets?: Secrets;
}

export interface TaigaProject {
  id: number;
  slug: string;
  name: string;
  /** Custom attributes defined on the project, per item type. */
  customAttributes: Record<ItemType, TaigaCustomAttribute[]>;
}

/** Custom attribute values of one item (`/{epics,userstories,tasks}/custom-attributes-values/{id}`). */
export interface TaigaAttributeValues {
  /** Attribute id (as a string, like Taiga's JSON keys) → value. */
  values: Record<string, unknown>;
  /** OCC version of the values object (separate from the item's own version). */
  version: number;
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
  /** Tasks only: the parent user story. */
  user_story?: number;
}

/** Manifest-managed fields an update may change (`user_story`: a task's parent); everything else is left alone. */
export type ItemPatch = Partial<Pick<TaigaItem, 'subject' | 'description' | 'tags'>> & { user_story?: number };

interface RequestOptions {
  query?: Record<string, string | number>;
  body?: unknown;
  /** Multipart body (attachments); used instead of `body`. */
  form?: FormData;
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

function field<T>(raw: Record<string, unknown>, name: string, type: 'number' | 'string' | 'boolean', what: string): T {
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

/**
 * Taiga's names for each item type: its REST collection (`/userstories`, also used under attachments and custom
 * attribute values), its custom attribute prefix (`/userstory-custom-attributes`, `userstory_custom_attributes`
 * of a project) and how messages name it.
 */
const TAIGA_ITEM: Record<ItemType, { collection: string; attributes: string; what: string }> = {
  epic: { collection: 'epics', attributes: 'epic', what: 'epic' },
  story: { collection: 'userstories', attributes: 'userstory', what: 'user story' },
  task: { collection: 'tasks', attributes: 'task', what: 'task' },
};

function parseItemOf(type: ItemType, raw: unknown): TaigaItem {
  return type === 'task' ? parseTask(raw) : parseItem(raw, TAIGA_ITEM[type].what);
}

function parseList<T>(raw: unknown, what: string, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(raw)) throw new TaigaError(`unexpected Taiga response: ${what} list is not an array`);
  return raw.map(parse);
}

// ---- Bootstrap types (project configuration) ------------------------------------------------------

/** Project module flags, as in `PATCH /projects/{id}`. */
export const MODULE_FLAGS = ['is_epics_activated', 'is_backlog_activated', 'is_kanban_activated', 'is_issues_activated', 'is_wiki_activated'] as const;
export type ModuleFlag = (typeof MODULE_FLAGS)[number];

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
  customAttributes: Record<ItemType, TaigaCustomAttribute[]>;
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

export interface TaigaWikiPage {
  id: number;
  slug: string;
  /** Markdown. */
  content: string;
  version: number;
}

/** What an attachment hangs off: an item or a wiki page (`/{epics,userstories,tasks,wiki}/attachments`). */
export type AttachmentTargetType = ItemType | 'wiki';

export interface TaigaAttachment {
  id: number;
  /** Id of the epic, user story, task or wiki page. */
  objectId: number;
  name: string;
  size: number;
  sha1: string;
}

export interface NewAttachment {
  project: number;
  object_id: number;
  /** Local path of the file to upload. */
  file: string;
  /** File name sent with the upload; Taiga names the attachment after it. */
  name: string;
  description: string;
}

// ---- Closed work (`taigent closed`) -----------------------------------------------------------------

/** Kinds of item Taiga assigns to people and closes. Issues are not backlog items (`ItemType`). */
export const WORK_ITEM_TYPES = ['story', 'task', 'issue'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

/**
 * How Taiga lists one type's closed items assigned to a user: its collection, the assignee filter (a story has
 * several `assigned_users`, a task or issue one `assigned_to`), the closed filter, and the field holding when the
 * item was closed (`finish_date` on stories, `finished_date` on tasks and issues).
 */
const TAIGA_WORK_ITEM: Record<WorkItemType, { collection: string; assignee: string; closed: string; closedAt: string; what: string }> = {
  story: { collection: 'userstories', assignee: 'assigned_users', closed: 'is_closed', closedAt: 'finish_date', what: 'user story' },
  task: { collection: 'tasks', assignee: 'assigned_to', closed: 'status__is_closed', closedAt: 'finished_date', what: 'task' },
  issue: { collection: 'issues', assignee: 'assigned_to', closed: 'status__is_closed', closedAt: 'finished_date', what: 'issue' },
};

/** A closed item, with the project and status names Taiga embeds in list responses (`*_extra_info`). */
export interface TaigaClosedItem {
  type: WorkItemType;
  id: number;
  ref: number;
  subject: string;
  status: string;
  project: { id: number; slug: string; name: string };
  /** When Taiga closed it (ISO 8601), or null when Taiga recorded no date. */
  closedAt: string | null;
}

function parseClosedItem(type: WorkItemType, raw: unknown): TaigaClosedItem {
  const { closedAt, what } = TAIGA_WORK_ITEM[type];
  const r = record(raw, what);
  const project = record(r.project_extra_info, `${what}.project_extra_info`);
  const status = record(r.status_extra_info, `${what}.status_extra_info`);
  return {
    type,
    id: field(r, 'id', 'number', what),
    ref: field(r, 'ref', 'number', what),
    subject: field(r, 'subject', 'string', what),
    status: field(status, 'name', 'string', `${what} status`),
    project: {
      id: field(project, 'id', 'number', `${what} project`),
      slug: field(project, 'slug', 'string', `${what} project`),
      name: field(project, 'name', 'string', `${what} project`),
    },
    closedAt: typeof r[closedAt] === 'string' ? r[closedAt] : null,
  };
}

// ---- Tickets (`taigent tickets`) --------------------------------------------------------------------

/** A user story assigned to someone, open or closed, with what Taiga embeds in list responses (`*_extra_info`). */
export interface TaigaAssignedStory {
  id: number;
  ref: number;
  subject: string;
  status: string;
  isClosed: boolean;
  project: { id: number; slug: string; name: string };
  /** User ids of every assignee (`assigned_users`). */
  assignedUsers: number[];
  /** Due day (YYYY-MM-DD, a plain date without time), or null. */
  dueDate: string | null;
  /** When Taiga closed it (`finish_date`, ISO 8601), or null: open, or closed without a recorded date. */
  closedAt: string | null;
}

function parseAssignedStory(raw: unknown): TaigaAssignedStory {
  const what = 'user story';
  const r = record(raw, what);
  const project = record(r.project_extra_info, `${what}.project_extra_info`);
  const status = record(r.status_extra_info, `${what}.status_extra_info`);
  return {
    id: field(r, 'id', 'number', what),
    ref: field(r, 'ref', 'number', what),
    subject: field(r, 'subject', 'string', what),
    status: field(status, 'name', 'string', `${what} status`),
    isClosed: field(r, 'is_closed', 'boolean', what),
    project: {
      id: field(project, 'id', 'number', `${what} project`),
      slug: field(project, 'slug', 'string', `${what} project`),
      name: field(project, 'name', 'string', `${what} project`),
    },
    assignedUsers: list(r.assigned_users ?? [], `${what}.assigned_users`).filter((id): id is number => typeof id === 'number'),
    dueDate: typeof r.due_date === 'string' ? r.due_date : null,
    closedAt: typeof r.finish_date === 'string' ? r.finish_date : null,
  };
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

/** `<epic|userstory|task>_custom_attributes` of a project detail object. */
function parseCustomAttributes(r: Record<string, unknown>): Record<ItemType, TaigaCustomAttribute[]> {
  const byType = ITEM_TYPES.map((type) => {
    const { attributes, what } = TAIGA_ITEM[type];
    return [type, list(r[`${attributes}_custom_attributes`] ?? [], `${what} custom attributes`).map(parseCustomAttribute)];
  });
  return Object.fromEntries(byType) as Record<ItemType, TaigaCustomAttribute[]>;
}

function parseAttributeValues(raw: unknown): TaigaAttributeValues {
  const r = record(raw, 'custom attributes values');
  return { values: record(r.attributes_values ?? {}, 'attributes_values'), version: field(r, 'version', 'number', 'custom attributes values') };
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
    customAttributes: parseCustomAttributes(r),
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

function parseWikiPage(raw: unknown): TaigaWikiPage {
  const page = record(raw, 'wiki page');
  return {
    id: field(page, 'id', 'number', 'wiki page'),
    slug: field(page, 'slug', 'string', 'wiki page'),
    content: field(page, 'content', 'string', 'wiki page'),
    version: field(page, 'version', 'number', 'wiki page'),
  };
}

function parseAttachment(raw: unknown): TaigaAttachment {
  const attachment = record(raw, 'attachment');
  return {
    id: field(attachment, 'id', 'number', 'attachment'),
    objectId: field(attachment, 'object_id', 'number', 'attachment'),
    name: field(attachment, 'name', 'string', 'attachment'),
    size: field(attachment, 'size', 'number', 'attachment'),
    sha1: field(attachment, 'sha1', 'string', 'attachment'),
  };
}

export class TaigaClient {
  readonly apiUrl: string;
  readonly #credentials: TaigaConnectOptions['credentials'];
  readonly #retryUnitMs: number;
  #token: string | undefined;
  #refresh: string | undefined;
  readonly #secrets: Secrets;

  private constructor(options: TaigaConnectOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.#credentials = options.credentials;
    this.#retryUnitMs = options.retryUnitMs ?? 1000;
    this.#secrets = options.secrets ?? new Secrets();
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
      customAttributes: parseCustomAttributes(raw),
    };
  }

  /** All items of one type in a project, unfiltered: every `src:` tag is needed to find orphans. */
  listItems(type: 'task', projectId: number): Promise<TaigaTask[]>;
  listItems(type: ItemType, projectId: number): Promise<TaigaItem[]>;
  async listItems(type: ItemType, projectId: number): Promise<TaigaItem[]> {
    const raw = await this.#request('GET', `/${TAIGA_ITEM[type].collection}`, { query: { project: projectId } });
    return parseList(raw, TAIGA_ITEM[type].what, (item) => parseItemOf(type, item));
  }

  async createItem(type: ItemType, item: NewItem): Promise<TaigaItem> {
    return parseItemOf(type, await this.#request('POST', `/${TAIGA_ITEM[type].collection}`, { body: item }));
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

  async updateItem(type: ItemType, id: number, patch: ItemPatch, version: number): Promise<TaigaItem> {
    return parseItemOf(type, await this.#patch(`/${TAIGA_ITEM[type].collection}/${id}`, patch, version));
  }

  /** Custom attribute values of an item (Taiga creates the values object together with the item). */
  async getAttributeValues(type: ItemType, itemId: number): Promise<TaigaAttributeValues> {
    return parseAttributeValues(await this.#request('GET', `/${TAIGA_ITEM[type].collection}/custom-attributes-values/${itemId}`));
  }

  /** Replaces all values of an item (attribute id → value), with the values object's `version` (OCC). */
  async updateAttributeValues(type: ItemType, itemId: number, values: Record<string, unknown>, version: number): Promise<TaigaAttributeValues> {
    const path = `/${TAIGA_ITEM[type].collection}/custom-attributes-values/${itemId}`;
    return parseAttributeValues(await this.#patch(path, { attributes_values: values }, version));
  }

  /** PATCH with the object's `version` (OCC); a stale version becomes a TaigaConflictError. */
  async #patch(path: string, patch: Record<string, unknown>, version: number): Promise<unknown> {
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

  /** Closed items of one type assigned to `userId`, in every project the user sees or in `projectId` only. */
  async listClosedAssigned(type: WorkItemType, userId: number, projectId?: number): Promise<TaigaClosedItem[]> {
    const { collection, assignee, closed, what } = TAIGA_WORK_ITEM[type];
    const query: Record<string, string | number> = { [assignee]: userId, [closed]: 'true' };
    if (projectId !== undefined) query.project = projectId;
    return parseList(await this.#request('GET', `/${collection}`, { query }), what, (item) => parseClosedItem(type, item));
  }

  /** Every user story assigned to `userId`, open and closed, in every project the user sees or in `projectId` only. */
  async listAssignedStories(userId: number, projectId?: number): Promise<TaigaAssignedStory[]> {
    const query: Record<string, string | number> = { assigned_users: userId };
    if (projectId !== undefined) query.project = projectId;
    return parseList(await this.#request('GET', '/userstories', { query }), 'user story', parseAssignedStory);
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

  /**
   * Whether a project the user cannot see has `slug`. `by_slug` answers 404 both for a free slug and for a private
   * project the user is not a member of; `GET /resolver?project=<slug>` answers 403 for the latter (taiga-back
   * `ResolverViewSet.list` looks the slug up unfiltered, then checks `view_project`) and 404 for a free slug.
   */
  async isSlugTakenByInvisibleProject(slug: string): Promise<boolean> {
    try {
      await this.#request('GET', '/resolver', { query: { project: slug } });
      return false;
    } catch (error) {
      if (error instanceof TaigaError && error.status === 403) return true;
      if (error instanceof TaigaError && error.status === 404) return false;
      throw error;
    }
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

  async createCustomAttribute(type: ItemType, attribute: NewCustomAttribute): Promise<TaigaCustomAttribute> {
    return parseCustomAttribute(await this.#request('POST', `/${TAIGA_ITEM[type].attributes}-custom-attributes`, { body: attribute }));
  }

  async listMemberships(projectId: number): Promise<TaigaMembership[]> {
    return list(await this.#request('GET', '/memberships', { query: { project: projectId } }), 'membership list').map(parseMembership);
  }

  /** Invites a user by username or e-mail (`POST /memberships`). */
  async createMembership(membership: NewMembership): Promise<TaigaMembership> {
    return parseMembership(await this.#request('POST', '/memberships', { body: membership }));
  }

  /** Wiki page by slug, or undefined when the page does not exist. */
  async findWikiPage(projectId: number, slug: string): Promise<TaigaWikiPage | undefined> {
    const raw = await this.#find('GET', '/wiki/by_slug', { query: { slug, project: projectId } });
    return raw === undefined ? undefined : parseWikiPage(raw);
  }

  async createWikiPage(page: { project: number; slug: string; content: string }): Promise<{ id: number }> {
    return { id: field(record(await this.#request('POST', '/wiki', { body: page }), 'wiki page'), 'id', 'number', 'wiki page') };
  }

  /** Replaces a wiki page's Markdown (`PATCH /wiki/{id}` with its `version`, OCC like items). */
  async updateWikiPage(id: number, content: string, version: number): Promise<TaigaWikiPage> {
    return parseWikiPage(await this.#patch(`/wiki/${id}`, { content }, version));
  }

  // ---- Attachments (multipart) -----------------------------------------------------------------------

  /** Attachments of one object (`GET /{epics,userstories,tasks,wiki}/attachments?object_id=&project=`). */
  async listAttachments(type: AttachmentTargetType, projectId: number, objectId: number): Promise<TaigaAttachment[]> {
    const collection = type === 'wiki' ? 'wiki' : TAIGA_ITEM[type].collection;
    const raw = await this.#request('GET', `/${collection}/attachments`, { query: { object_id: objectId, project: projectId } });
    return parseList(raw, 'attachment', parseAttachment);
  }

  /**
   * Uploads `attachment.file` as multipart (`POST /{epics,userstories,tasks,wiki}/attachments`). The file is streamed
   * from disk (a file-backed Blob): it is never read into memory as a whole, and a retry (401, 429) reads it again.
   */
  async uploadAttachment(type: AttachmentTargetType, attachment: NewAttachment): Promise<TaigaAttachment> {
    const collection = type === 'wiki' ? 'wiki' : TAIGA_ITEM[type].collection;
    const form = new FormData();
    form.set('object_id', String(attachment.object_id));
    form.set('project', String(attachment.project));
    form.set('description', attachment.description);
    form.set('attached_file', await openAsBlob(attachment.file), attachment.name);
    return parseAttachment(await this.#request('POST', `/${collection}/attachments`, { form }));
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
        // FormData (multipart, fetch sets the boundary) streams its file-backed Blobs from disk.
        body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, retryAfter: response.headers.get('retry-after'), text };
    } catch (error) {
      // fetch() reports the real reason (ECONNREFUSED, DNS failure, ...) as the error's cause.
      const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
      throw new TaigaError(this.#secrets.redact(`cannot reach Taiga at ${this.apiUrl}: ${errorMessage(reason)}`));
    }
  }

  /** `METHOD /path failed: HTTP <status> <body>`, with any secret Taiga echoed redacted (before truncating). */
  #failure(method: string, path: string, response: RawResponse): string {
    const text = this.#secrets.redact(response.text);
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
}

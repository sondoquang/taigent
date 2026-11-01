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

/** A PATCH was refused because the item changed on Taiga since its `version` was read (OCC). */
export class TaigaConflictError extends TaigaError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'TaigaConflictError';
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
}

const MAX_ERROR_BODY = 500;

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

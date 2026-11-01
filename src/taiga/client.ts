// Taiga client: owns all HTTP to the Taiga REST API (https://docs.taiga.io/api.html).
// Knows Taiga endpoints only, never manifests. Every request disables pagination.

import { isRecord } from '../guards.ts';

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
      const cause = (error as Error & { cause?: Error }).cause;
      throw new TaigaError(`cannot reach Taiga at ${this.apiUrl}: ${cause?.message ?? (error as Error).message}`);
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

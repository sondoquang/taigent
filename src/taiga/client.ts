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
  async listEpics(projectId: number): Promise<TaigaEpic[]> {
    const raw = await this.#request('GET', '/epics', { query: { project: projectId } });
    if (!Array.isArray(raw)) throw new TaigaError('unexpected Taiga response: epic list is not an array');
    return raw.map(parseEpic);
  }

  async createEpic(epic: NewEpic): Promise<TaigaEpic> {
    return parseEpic(await this.#request('POST', '/epics', { body: epic }));
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

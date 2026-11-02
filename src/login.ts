// Stored login (`taigent login`): the password is typed once and never stored. What is stored instead:
// - `<config dir>/login.json`, not secret: the Taiga API URL, the username and the login method;
// - one secret in the OS credential store (Windows Credential Manager, macOS Keychain, Linux Secret Service),
//   or in `<config dir>/credentials.json` with TAIGENT_CREDENTIAL_STORE=file: a refresh token pair (default)
//   or an application token (`--application <id>`, needs an Application the instance admin created).
// The CLI and every `taigent mcp` share the stored token pair. Taiga spends a refresh token on use, so renewals
// go through a lock file and re-read the store first: a process that lost the race adopts the winner's pair.

import type * as Keyring from '@napi-rs/keyring';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, isFileNotFound, isRecord } from './guards.ts';
import type { Secrets } from './secrets.ts';
import { TaigaClient, TaigaError, type TaigaAuthorizer } from './taiga/client.ts';

/** No usable stored login, or `taigent login` cannot run here. Maps to ExitCode.Usage. */
export class LoginError extends Error {}

export const LOGIN_HINT = 'run `npx taigent login` in your own terminal';

/** Service name of the OS credential store entries; the account is the Taiga API URL. */
const SERVICE = 'taigent';
const LOCK_WAIT_MS = 15_000;
/** A lock file older than this is left over by a killed process. */
const LOCK_STALE_MS = 30_000;

export type LoginMethod = 'refresh-token' | 'application-token';

/** `login.json`: which Taiga, who, and how. Holds no secret. */
export interface LoginRecord {
  apiUrl: string;
  username: string;
  method: LoginMethod;
  /** Application id, for `application-token`. */
  application?: string;
}

type StoredSecret = { accessToken: string; refreshToken: string } | { applicationToken: string };

interface SecretStore {
  /** Where the secret lives, for messages. */
  readonly label: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/** TAIGENT_CONFIG_DIR, else the platform's per-user configuration directory + `/taigent`. */
export function configDir(env: NodeJS.ProcessEnv): string {
  if (env.TAIGENT_CONFIG_DIR) return env.TAIGENT_CONFIG_DIR;
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'taigent');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'taigent');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'taigent');
}

/** The API URL as stored and compared: no trailing slash. */
export function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '');
}

/** TAIGENT_CREDENTIAL_STORE: `keyring` (default, the OS credential store) or `file` (headless machines without one). */
async function openSecretStore(env: NodeJS.ProcessEnv): Promise<SecretStore> {
  const kind = env.TAIGENT_CREDENTIAL_STORE || 'keyring';
  if (kind === 'file') return fileStore(join(configDir(env), 'credentials.json'));
  if (kind !== 'keyring') throw new LoginError(`TAIGENT_CREDENTIAL_STORE must be "keyring" or "file", got "${kind}"`);
  let keyring: typeof Keyring;
  try {
    // Loaded on demand: a native binary, missing on unsupported platforms and needed only with a stored login.
    keyring = await import('@napi-rs/keyring');
  } catch (error) {
    throw new LoginError(`the OS credential store is not available on this machine (${errorMessage(error)}); set TAIGENT_CREDENTIAL_STORE=file`);
  }
  // On Linux, never fall back to the kernel keyutils store silently: it is lost on reboot.
  const entry = (account: string) => new keyring.AsyncEntry(SERVICE, account, { linux: { store: 'secret-service' } });
  const label = { win32: 'Windows Credential Manager', darwin: 'macOS Keychain' }[process.platform as string] ?? 'Secret Service';
  const failed = (error: unknown): never => {
    throw new LoginError(`cannot use the ${label} (${errorMessage(error)}); unlock it, or set TAIGENT_CREDENTIAL_STORE=file`);
  };
  return {
    label,
    get: async (account) => (await entry(account).getPassword().catch(failed)) ?? undefined,
    set: async (account, value) => void (await entry(account).setPassword(value).catch(failed)),
    delete: async (account) => void (await entry(account).deletePassword().catch(failed)),
  };
}

/** Plain JSON readable by the user only (mode 0600; on Windows the profile directory's ACL). */
function fileStore(path: string): SecretStore {
  const read = async (): Promise<Record<string, string>> => {
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
      return isRecord(raw) ? (raw as Record<string, string>) : {};
    } catch (error) {
      if (isFileNotFound(error)) return {};
      throw new LoginError(`cannot read ${path}: ${errorMessage(error)}`);
    }
  };
  const write = async (values: Record<string, string>): Promise<void> => {
    if (Object.keys(values).length === 0) return rm(path, { force: true });
    await writeFile(path, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  return {
    label: `the file ${path}`,
    get: async (account) => (await read())[account],
    set: async (account, value) => write({ ...(await read()), [account]: value }),
    delete: async (account) => {
      const { [account]: _removed, ...rest } = await read();
      await write(rest);
    },
  };
}

async function readRecord(dir: string): Promise<LoginRecord | undefined> {
  const path = join(dir, 'login.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new LoginError(`cannot read ${path} (${errorMessage(error)}): ${LOGIN_HINT}`);
  }
  if (
    !isRecord(raw) || typeof raw.apiUrl !== 'string' || typeof raw.username !== 'string' ||
    (raw.method !== 'refresh-token' && raw.method !== 'application-token') ||
    (raw.method === 'application-token' && typeof raw.application !== 'string')
  ) {
    throw new LoginError(`${path} is not a taigent login: ${LOGIN_HINT}`);
  }
  return { apiUrl: raw.apiUrl, username: raw.username, method: raw.method, ...(typeof raw.application === 'string' && { application: raw.application }) };
}

function parseSecret(text: string | undefined, record: LoginRecord, store: SecretStore): StoredSecret {
  let raw: unknown;
  try {
    raw = text === undefined ? undefined : JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (isRecord(raw)) {
    if (record.method === 'application-token' && typeof raw.applicationToken === 'string') return { applicationToken: raw.applicationToken };
    if (record.method === 'refresh-token' && typeof raw.accessToken === 'string' && typeof raw.refreshToken === 'string') {
      return { accessToken: raw.accessToken, refreshToken: raw.refreshToken };
    }
  }
  throw new LoginError(`the login to ${record.apiUrl} has no usable token in ${store.label}: ${LOGIN_HINT}`);
}

/** Runs `fn` while holding `<dir>/login.lock`, shared by every taigent process of the user. */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(dir, 'login.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(path, 'wx')).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new LoginError(`timed out waiting for ${path}; delete it if no taigent is running`);
    await sleep(50);
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** The stored login, as the Authorization header source of the CLI's client and of the `taigent mcp` proxy. */
export class StoredSession implements TaigaAuthorizer {
  readonly credential = 'login';
  readonly record: LoginRecord;
  readonly storeLabel: string;
  readonly #dir: string;
  readonly #store: SecretStore;
  readonly #secrets: Secrets;
  #secret: StoredSecret;

  private constructor(dir: string, record: LoginRecord, store: SecretStore, secret: StoredSecret, secrets: Secrets) {
    this.#dir = dir;
    this.record = record;
    this.#store = store;
    this.storeLabel = store.label;
    this.#secrets = secrets;
    this.#secret = secret;
    this.#remember(secret);
  }

  /** The stored login, or undefined when the user never logged in (or logged out). */
  static async open(env: NodeJS.ProcessEnv, secrets: Secrets): Promise<StoredSession | undefined> {
    const dir = configDir(env);
    const record = await readRecord(dir);
    if (!record) return undefined;
    const store = await openSecretStore(env);
    return new StoredSession(dir, record, store, parseSecret(await store.get(record.apiUrl), record, store), secrets);
  }

  authorization(): string {
    return 'applicationToken' in this.#secret ? `Application ${this.#secret.applicationToken}` : `Bearer ${this.#secret.accessToken}`;
  }

  async renew(rejected: string): Promise<boolean> {
    if (this.record.method === 'application-token') return false;
    return withLock(this.#dir, async () => {
      const latest = parseSecret(await this.#store.get(this.record.apiUrl), this.record, this.#store);
      this.#adopt(latest);
      // Another process renewed the pair meanwhile: use its access token rather than spending its refresh token.
      if (this.authorization() !== rejected) return true;
      if (!('refreshToken' in latest)) return false;
      const pair = await TaigaClient.refresh({ apiUrl: this.record.apiUrl, refreshToken: latest.refreshToken, secrets: this.#secrets });
      await this.#store.set(this.record.apiUrl, JSON.stringify(pair));
      this.#adopt(pair);
      return true;
    });
  }

  #adopt(secret: StoredSecret): void {
    this.#secret = secret;
    this.#remember(secret);
  }

  #remember(secret: StoredSecret): void {
    for (const value of Object.values(secret)) this.#secrets.add(value);
  }
}

/**
 * `taigent login`: exchanges the password for a refresh token pair, or (with `application`) an application token,
 * stores it and writes login.json. Replaces any previous login. The password is used once and dropped.
 */
export async function storeLogin(input: {
  env: NodeJS.ProcessEnv;
  apiUrl: string;
  username: string;
  password: string;
  application?: string;
  secrets: Secrets;
}): Promise<{ record: LoginRecord; storeLabel: string }> {
  const { env, username, password, application, secrets } = input;
  const apiUrl = normalizeApiUrl(input.apiUrl);
  const pair = await TaigaClient.login({ apiUrl, credentials: { username, password }, secrets });
  let secret: StoredSecret = pair;
  if (application !== undefined) {
    const client = await TaigaClient.connect({ apiUrl, token: pair.accessToken, secrets });
    secret = { applicationToken: await client.createApplicationToken(application) };
  }
  const record: LoginRecord = application === undefined ? { apiUrl, username, method: 'refresh-token' } : { apiUrl, username, method: 'application-token', application };

  const dir = configDir(env);
  await mkdir(dir, { recursive: true });
  const store = await openSecretStore(env);
  const previous = await readRecord(dir).catch(() => undefined);
  await store.set(apiUrl, JSON.stringify(secret));
  await writeFile(join(dir, 'login.json'), `${JSON.stringify(record, null, 2)}\n`);
  if (previous && previous.apiUrl !== apiUrl) await store.delete(previous.apiUrl);
  return { record, storeLabel: store.label };
}

/**
 * `taigent logout`: deletes the stored login. An application token is deleted on Taiga first (Taiga would hand the
 * same one out again); a refresh token pair cannot be revoked by the user (Taiga has no logout endpoint).
 * Returns undefined when there was no stored login.
 */
export async function removeLogin(env: NodeJS.ProcessEnv, secrets: Secrets): Promise<{ record: LoginRecord; revoked: number } | undefined> {
  const dir = configDir(env);
  const record = await readRecord(dir).catch(() => undefined);
  if (!record) return undefined;
  let revoked = 0;
  let revokeError: unknown;
  if (record.method === 'application-token') {
    try {
      const session = await StoredSession.open(env, secrets);
      const client = await TaigaClient.connect({ apiUrl: record.apiUrl, authorizer: session!, secrets });
      revoked = await client.deleteApplicationTokens(record.application!);
    } catch (error) {
      revokeError = error;
    }
  }
  const store = await openSecretStore(env);
  await store.delete(record.apiUrl);
  await rm(join(dir, 'login.json'), { force: true });
  if (revokeError !== undefined) {
    const reason = errorMessage(revokeError);
    throw new TaigaError(`removed the stored login, but deleting the application token on Taiga failed: ${reason}`);
  }
  return { record, revoked };
}

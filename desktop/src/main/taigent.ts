// Where taigent lives and how the app uses it: its core modules (`dist/*.js`) are imported in this process, and
// the CLI (`bin/taigent.js`) runs as a child of this same executable in Node mode (ELECTRON_RUN_AS_NODE), so the
// packaged app needs no system Node. In development taigent is the repository this folder sits in; packaged, it is
// the copy `scripts/stage-taigent.mjs` puts under `resources/taigent/node_modules/taigent`.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import type * as EditModule from '../../../src/edit.ts';
import type * as LoginModule from '../../../src/login.ts';
import type * as ProjectModule from '../../../src/manifest/project.ts';
import type * as ReviewModule from '../../../src/review.ts';
import type * as SecretsModule from '../../../src/secrets.ts';
import type * as ClientModule from '../../../src/taiga/client.ts';
import { OWN_GROUP, track } from './processes.ts';

export function taigentRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'taigent', 'node_modules', 'taigent') : resolve(app.getAppPath(), '..');
}

export function taigentVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(taigentRoot(), 'package.json'), 'utf8'));
    if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // unreadable: reported as unknown below
  }
  return 'unknown';
}

export interface Core {
  review: typeof ReviewModule;
  edit: typeof EditModule;
  project: typeof ProjectModule;
  login: typeof LoginModule;
  secrets: typeof SecretsModule;
  client: typeof ClientModule;
}

let core: Promise<Core> | undefined;

/** taigent's compiled core, loaded once. Development needs `npm run build` at the repository root first. */
export function loadCore(): Promise<Core> {
  core ??= (async () => {
    const dist = join(taigentRoot(), 'dist');
    const load = (file: string) => import(pathToFileURL(join(dist, file)).href);
    try {
      const [review, edit, project, login, secrets, client] = await Promise.all([
        load('review.js'),
        load('edit.js'),
        load('manifest/project.js'),
        load('login.js'),
        load('secrets.js'),
        load('taiga/client.js'),
      ]);
      return { review, edit, project, login, secrets, client } as Core;
    } catch (error) {
      core = undefined;
      throw new Error(
        `Không nạp được lõi taigent ở ${dist} (${(error as Error).message}). ` +
          (app.isPackaged ? 'Hãy cài lại ứng dụng.' : 'Chạy `npm run build` ở thư mục gốc của taigent rồi mở lại ứng dụng.'),
        { cause: error },
      );
    }
  })();
  return core;
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `taigent <args>` in `cwd` (the opened repository) with this executable as Node; no shell. Tracked, so quitting kills it. */
export function runCli(args: string[], cwd: string): Promise<CliRun> {
  const { promise, resolve: done, reject } = Promise.withResolvers<CliRun>();
  const child = track(
    spawn(process.execPath, [join(taigentRoot(), 'bin', 'taigent.js'), ...args], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...OWN_GROUP,
    }),
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.on('error', reject);
  child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  return promise;
}

export interface CliError {
  kind?: string;
  message: string;
  issues?: { file: string; path: string; rule: string; message: string }[];
  /** HTTP status of a `taiga` or `conflict` error. */
  status?: number | null;
  /** What a `conflict` stopped on, e.g. `wiki:<slug>`. */
  key?: string | null;
  /** The file Taiga refused as too large (`upload`). */
  file?: string;
}

/** The `--json` body of a run, or its `{ error }` (stdout), falling back to the `taigent: <message>` stderr lines. */
export function parseCliJson<T>(run: CliRun): { value?: T; error?: CliError } {
  let body: unknown;
  try {
    body = JSON.parse(run.stdout);
  } catch {
    body = undefined;
  }
  if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
    // taigent's documented `--json` error body: `{ error: { kind, message, issues? } }` (docs/cli.md).
    const error = body.error as CliError;
    return { error };
  }
  if ((run.code === 0 || run.code === 3 || run.code === 6) && body !== undefined) {
    // taigent's documented `--json` output for the command the caller ran; `plan` still prints its plan on exit 6
    // (blocked items), `apply --yes` prints the `{ error }` body handled above instead.
    const value = body as T;
    return { value };
  }
  const stderr = run.stderr
    .split(/\r?\n/)
    .map((line) => line.replace(/^taigent: /, ''))
    .filter(Boolean)
    .join('\n');
  return { error: { message: stderr || `taigent thoát với mã ${run.code}` } };
}

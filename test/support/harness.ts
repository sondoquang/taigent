// Test harness: one fake Taiga + one temp working directory per test, and a way to run the real
// `taigent` CLI (bin/taigent.js) against them exactly like a user or agent would.
//
// Manifests live in `<cwd>/taiga/<slug>/` (the CLI default), so tests also cover the default layout.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StateFile } from '../../src/manifest/state.ts';
import { startFakeTaiga, type FakeTaiga } from './fake-taiga.ts';

const BIN = fileURLToPath(new URL('../../bin/taigent.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON (throws with the raw output if it is not JSON). The caller names the shape. */
  json<T>(): T;
}

export interface RunOptions {
  /** Extra/overriding env vars; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface Harness {
  fake: FakeTaiga;
  /** Temp directory used as the CLI's working directory. */
  cwd: string;
  /** `<cwd>/taiga`, the default manifests root. */
  manifestsDir: string;
  /** Env passed to the CLI: TAIGA_API_URL (the fake) + the fake user's credentials. */
  env: Record<string, string>;
  writeManifest(slug: string, file: string, content: string): Promise<void>;
  /** Parsed `<manifestsDir>/<slug>/state.json`, or undefined when absent. */
  readState(slug: string): Promise<StateFile | undefined>;
  deleteState(slug: string): Promise<void>;
  taigent(args: string[], options?: RunOptions): Promise<CliResult>;
}

/** Runs `node bin/taigent.js ...args` asynchronously (the fake server lives in this process). */
export async function runTaigent(args: string[], options: { env: Record<string, string | undefined>; cwd: string }): Promise<CliResult> {
  // Never leak the developer's real Taiga credentials or overrides into a test run.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(TAIGA_|TAIGENT_)/i.test(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(options.env)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const child = spawn(process.execPath, [BIN, ...args], { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [code] = (await once(child, 'close')) as [number | null];
  return {
    code,
    stdout,
    stderr,
    json<T>() {
      try {
        return JSON.parse(stdout) as T;
      } catch {
        throw new Error(`stdout is not JSON.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
    },
  };
}

export async function startHarness(t: TestContext): Promise<Harness> {
  const fake = await startFakeTaiga();
  const cwd = await mkdtemp(join(tmpdir(), 'taigent-test-'));
  t.after(async () => {
    await fake.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const manifestsDir = join(cwd, 'taiga');
  const env = { TAIGA_API_URL: fake.url, TAIGA_USERNAME: fake.user.username, TAIGA_PASSWORD: fake.user.password };
  const statePath = (slug: string) => join(manifestsDir, slug, 'state.json');

  return {
    fake,
    cwd,
    manifestsDir,
    env,
    async writeManifest(slug, file, content) {
      await mkdir(join(manifestsDir, slug), { recursive: true });
      await writeFile(join(manifestsDir, slug, file), content);
    },
    async readState(slug) {
      try {
        return JSON.parse(await readFile(statePath(slug), 'utf8')) as StateFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async deleteState(slug) {
      await rm(statePath(slug));
    },
    taigent: (args, options = {}) => runTaigent(args, { env: { ...env, ...options.env }, cwd: options.cwd ?? cwd }),
  };
}

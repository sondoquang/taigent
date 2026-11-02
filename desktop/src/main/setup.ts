// The setup wizard's main side (spec #35, ticket #40): a new repository (folder, `git init`, `taiga/`), a clone of a
// URL, the opened repository's Taigent state and `taigent init` run by the app's own taigent (not the repository's),
// and the terminal tabs the wizard opens (npm install, a tool's install command). git runs through execFile, never a
// shell, never prompts in a terminal, and under a timeout. A failed creation or clone removes the folder it made.

import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { CloneRepoInput, InitReport, NewRepoInput, Result, SetupStatus, SetupTool, TerminalTab } from '../shared/api.ts';
import { SETUP_TOOLS } from '../shared/api.ts';
import { failure } from './project.ts';
import { parseCliJson, runCli, taigentVersion } from './taigent.ts';
import { killTree, shellRun, terminals } from './terminal.ts';
import { hasGit, INSTALL_COMMANDS } from './tools.ts';

const GIT_INIT_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const NO_GIT = `Không tìm thấy git trên máy. Hãy cài Git (\`${INSTALL_COMMANDS.git}\`) rồi thử lại.`;

interface GitRun {
  code: number;
  stderr: string;
  timedOut: boolean;
}

/** `git <args>` in `cwd` without a shell; never prompts in a terminal; the whole process tree is killed at `timeoutMs`. */
function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
  const { promise, resolve } = Promise.withResolvers<GitRun>();
  let timedOut = false;
  const child = execFile(
    'git',
    args,
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    (error, _stdout, stderr) => {
      clearTimeout(timer);
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stderr, timedOut });
    },
  );
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) void killTree(child.pid);
    child.kill('SIGKILL');
  }, timeoutMs);
  return promise;
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** The folder a new or cloned repository goes in: `<parent>/<name>`, with a plain folder name, not there yet. */
async function newFolder(parent: unknown, name: unknown): Promise<Result<string>> {
  if (typeof parent !== 'string' || !isAbsolute(parent) || !(await stat(parent).then((info) => info.isDirectory(), () => false))) {
    return failure('Hãy chọn thư mục chứa repo.');
  }
  const folder = typeof name === 'string' ? name.trim() : '';
  if (!folder) return failure('Hãy nhập tên thư mục của repo.');
  if (
    folder === '.' ||
    folder === '..' ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(folder) ||
    /[. ]$/.test(folder) ||
    /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(folder)
  ) {
    return failure(`"${folder}" không dùng được làm tên thư mục (không chứa / \\ : * ? " < > |, không kết thúc bằng dấu chấm).`);
  }
  const path = join(parent, folder);
  if (await exists(path)) return failure(`Đã có ${path}. Hãy chọn tên khác.`);
  return { ok: true, value: path };
}

/** Removes a folder the wizard made; true when it is gone. */
async function removeFolder(path: string): Promise<boolean> {
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  return !(await exists(path));
}

/** A new repository `<parent>/<name>`: the folder, `git init`, `taiga/` (kept by a `.gitkeep`) and a `.gitignore`. */
export async function createRepo(input: NewRepoInput): Promise<Result<string>> {
  const folder = await newFolder(input?.parent, input?.name);
  if (!folder.ok) return folder;
  if (!(await hasGit())) return failure(NO_GIT);
  const path = folder.value;
  await mkdir(path);
  const run = await runGit(path, ['init', '--quiet'], GIT_INIT_TIMEOUT_MS);
  if (run.code !== 0) {
    await removeFolder(path);
    return failure('git init thất bại; thư mục vừa tạo đã được xoá.', { detail: run.stderr.trim() || undefined });
  }
  await mkdir(join(path, 'taiga'));
  await writeFile(join(path, 'taiga', '.gitkeep'), '');
  await writeFile(join(path, '.gitignore'), 'node_modules/\n.env\n');
  return { ok: true, value: path };
}

/** The URL as git takes it: http(s), ssh, git, file URL, `user@host:path` or a local absolute path; never an option. */
function cloneUrl(raw: unknown): Result<string> {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return failure('Hãy nhập URL của repo.');
  const valid =
    !/[\s\u0000-\u001f]/.test(url) &&
    !url.startsWith('-') &&
    (/^(https?|ssh|git|file):\/\//i.test(url) || /^[\w.-]+@[\w.-]+:/.test(url) || isAbsolute(url));
  if (!valid) {
    return failure(`"${url}" không phải URL của repo git (ví dụ https://github.com/<tổ chức>/<repo>.git hoặc git@github.com:<tổ chức>/<repo>.git).`);
  }
  return { ok: true, value: url };
}

/** Why a clone failed, in Vietnamese, from git's own message. */
function cloneFailure(run: GitRun): string {
  if (run.timedOut) return `Clone quá ${CLONE_TIMEOUT_MS / 60_000} phút nên đã dừng.`;
  const text = run.stderr.toLowerCase();
  if (/not found|does not exist|does not appear to be a git repository|returned error: 404/.test(text)) {
    return 'Không tìm thấy repo ở URL này. Kiểm tra lại URL; với repo riêng tư, có thể tài khoản git trên máy chưa có quyền xem repo.';
  }
  if (/authentication failed|permission denied|could not read (username|password)|terminal prompts disabled|returned error: 40[13]|access denied|access rights/.test(text)) {
    return 'Không có quyền truy cập repo này (hoặc URL sai). Đăng nhập git trên máy bằng tài khoản có quyền (Git Credential Manager hoặc SSH key) rồi thử lại.';
  }
  if (/could not resolve host|unable to access|failed to connect|timed out|network is unreachable|connection refused/.test(text)) {
    return 'Không kết nối được tới máy chủ git. Kiểm tra mạng và URL.';
  }
  return 'Clone thất bại.';
}

/** `git clone -- <url> <parent>/<name>`; on failure the folder is removed, so nothing half-cloned stays. */
export async function cloneRepo(input: CloneRepoInput): Promise<Result<string>> {
  const url = cloneUrl(input?.url);
  if (!url.ok) return url;
  const folder = await newFolder(input?.parent, input?.name);
  if (!folder.ok) return folder;
  if (!(await hasGit())) return failure(NO_GIT);
  const path = folder.value;
  const run = await runGit(input.parent, ['clone', '--', url.value, path], CLONE_TIMEOUT_MS);
  if (run.code === 0 && !run.timedOut) return { ok: true, value: path };
  const removed = await removeFolder(path);
  // A URL may carry credentials (https://user:token@host/...): git echoes the URL, the app never shows them.
  const detail = run.stderr.replace(/\/\/[^/@\s]+@/g, '//***@').trim() || undefined;
  const leftover = removed ? '' : ` Không xoá được thư mục dở ${path}: hãy xoá nó bằng tay.`;
  return failure(cloneFailure(run) + leftover, { detail });
}

/** The opened repository's Taigent state, from `taigent init --dry-run --json` of the app's taigent. */
export async function setupStatus(root: string): Promise<Result<SetupStatus>> {
  const taigent = taigentVersion();
  const run = await runCli(['init', '--dry-run', '--json'], root);
  const { value, error } = parseCliJson<InitReport>(run);
  if (!value) return { ok: true, value: { state: 'unavailable', changes: [], taigent, message: error?.message } };
  const changes = value.files.filter((file) => file.status !== 'unchanged');
  const skills = value.files.filter((file) => file.path.startsWith('.agents/skills/'));
  const state = changes.length === 0 ? 'current' : skills.every((file) => file.status === 'created') ? 'none' : 'outdated';
  return { ok: true, value: { state, changes, taigent } };
}

/** `taigent init --json` of the app's taigent in the opened repository. */
export async function runInit(root: string): Promise<Result<InitReport>> {
  const run = await runCli(['init', '--json'], root);
  const { value, error } = parseCliJson<InitReport>(run);
  if (value && run.code === 0) return { ok: true, value };
  return failure('Không cài được Taigent vào repo (taigent init).', { detail: error?.message });
}

/** A terminal tab running `npm install` in the repository; on Windows through cmd, which runs the `npm.cmd` shim. */
export function openNpmInstall(root: string): TerminalTab {
  const command =
    process.platform === 'win32'
      ? { file: process.env.ComSpec || join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', 'npm install'] }
      : { file: 'npm', args: ['install'] };
  return terminals.open({ kind: 'skill', cwd: root, title: 'npm install', command }).tab;
}

/** A terminal tab whose shell runs `tool`'s install command, at the repository (or the home folder without one). */
export function openInstall(tool: unknown, root: string | undefined): Result<TerminalTab> {
  const known = SETUP_TOOLS.find((name): name is SetupTool => name === tool);
  if (!known) return failure(`Không có lệnh cài cho ${String(tool)}.`);
  const tab = terminals.open({ kind: 'skill', cwd: root ?? homedir(), title: `Cài ${known}`, command: shellRun(INSTALL_COMMANDS[known]) }).tab;
  return { ok: true, value: tab };
}

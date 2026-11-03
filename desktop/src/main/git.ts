// The Git section (spec #35 §Git): status, pull and commit + push of the manifests folder (`taiga/`) and the files
// its docs.yaml files reference, and nothing else. git runs through execFile, never a shell. The app never merges,
// rebases or force-pushes and never adds a path outside that scope: whatever would need it stops with a Vietnamese
// explanation and opens a shell tab at the repository in the terminal panel, with the commands to run there.

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as YamlModule from '../../../src/manifest/yaml.ts';
import type { GitChange, GitOutcome, GitStatus, GitStop, Result } from '../shared/api.ts';
import { OWN_GROUP, track } from './processes.ts';
import { manifestsDir } from './repo.ts';
import { taigentRoot } from './taigent.ts';
import { terminals } from './terminal.ts';

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

class GitMissing extends Error {}

/** Runs `git <args>` in `cwd` without a shell; `input` goes to stdin. Never prompts for credentials. */
function git(cwd: string, args: string[], input?: string): Promise<GitRun> {
  const { promise, resolve: done, reject } = Promise.withResolvers<GitRun>();
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const options = { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000, windowsHide: true, ...OWN_GROUP } as const;
  const child = track(
    execFile('git', args, options, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return reject(new GitMissing('git not found'));
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    }),
  );
  child.stdin?.end(input);
  return promise;
}

/** The text of a failed run, for `GitStop.detail`. */
function output(run: GitRun): string {
  return (run.stderr.trim() || run.stdout.trim() || `git thoát với mã ${run.code}`).trim();
}

let yaml: Promise<typeof YamlModule> | undefined;

/** taigent's YAML reader (`dist/manifest/yaml.js`), loaded once. */
function loadYaml(): Promise<typeof YamlModule> {
  yaml ??= import(pathToFileURL(join(taigentRoot(), 'dist', 'manifest', 'yaml.js')).href);
  return yaml;
}

/** The `file` of every wiki page and attachment a docs.yaml declares, as written (relative to docs.yaml). */
function referencedFiles(docs: unknown): string[] {
  if (typeof docs !== 'object' || docs === null) return [];
  const lists = [('wiki' in docs && docs.wiki) || [], ('attachments' in docs && docs.attachments) || []];
  const files: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as unknown[]) {
      if (typeof entry === 'object' && entry !== null && 'file' in entry && typeof entry.file === 'string' && entry.file) files.push(entry.file);
    }
  }
  return files;
}

/**
 * The paths the section may add, relative to the work tree top with `/`: the manifests folder and every file a
 * `<manifests>/<slug>/docs.yaml` references outside it. Paths outside the opened folder are left out, and so is the
 * opened folder itself (a manifests folder set to the whole repository would put everything in scope).
 */
async function scopeOf(root: string, prefix: string): Promise<string[]> {
  const inRepo = (path: string): string | undefined => {
    const rel = relative(root, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? prefix + rel.split(sep).join('/') : undefined;
  };
  const dir = manifestsDir(root);
  const paths = new Set<string>();
  const manifests = inRepo(dir);
  if (manifests) paths.add(manifests);
  const { readManifestYaml } = await loadYaml();
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const project = join(dir, entry.name);
    const docs = await readManifestYaml(join(project, 'docs.yaml')).catch(() => undefined);
    for (const file of referencedFiles(docs)) {
      const path = resolve(project, file);
      const underManifests = relative(dir, path);
      if (manifests && !underManifests.startsWith('..') && !isAbsolute(underManifests)) continue;
      const scoped = inRepo(path);
      if (scoped) paths.add(scoped);
    }
  }
  return [...paths].sort();
}

function inScope(scope: string[], path: string): boolean {
  return scope.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

const CONFLICTS: Record<string, true> = { DD: true, AU: true, UD: true, UA: true, DU: true, AA: true, UU: true };

function changeState(xy: string): GitChange['state'] {
  if (xy === '??') return 'untracked';
  if (CONFLICTS[xy]) return 'conflicted';
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'A') return 'added';
  return 'modified';
}

/** What git knows about the opened folder, read without touching the network. */
interface Repo {
  root: string;
  /** The opened folder relative to the work tree top: '' or `sub/`. */
  prefix: string;
  branch?: string;
  remotes: string[];
  /** The branch's upstream: remote name and ref (`refs/heads/main`). */
  remote?: string;
  merge?: string;
  scope: string[];
  changes: GitChange[];
  outside: number;
  /** Unmerged paths anywhere, or a merge, rebase, cherry-pick or revert in progress. */
  conflict: boolean;
  ahead: number;
  behind: number;
}

function upstreamName(repo: Repo): string | undefined {
  return repo.remote && repo.merge ? `${repo.remote}/${repo.merge.replace(/^refs\/heads\//, '')}` : undefined;
}

function toStatus(repo: Repo): GitStatus {
  return {
    ...(repo.branch ? { branch: repo.branch } : {}),
    ...(upstreamName(repo) ? { upstream: upstreamName(repo) } : {}),
    ahead: repo.ahead,
    behind: repo.behind,
    scope: repo.scope,
    changes: repo.changes,
    outside: repo.outside,
  };
}

function stop(reason: GitStop['reason'], message: string, commands: string[] = [], detail?: string): GitStop {
  return { reason, message, commands, terminal: false, ...(detail ? { detail } : {}) };
}

function failed(what: string, run: GitRun, commands: string[] = ['git status']): GitStop {
  return stop('failed', `${what} thất bại.`, commands, output(run));
}

async function config(root: string, key: string): Promise<string | undefined> {
  const run = await git(root, ['config', '--get', key]);
  return run.code === 0 ? run.stdout.trim() || undefined : undefined;
}

async function counts(root: string): Promise<{ ahead: number; behind: number }> {
  const run = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
  const [ahead, behind] = run.stdout.trim().split(/\s+/).map(Number);
  return run.code === 0 && Number.isInteger(ahead) && Number.isInteger(behind) ? { ahead: ahead!, behind: behind! } : { ahead: 0, behind: 0 };
}

async function readRepoState(root: string): Promise<Repo | GitStop> {
  const top = await git(root, ['rev-parse', '--show-prefix']);
  if (top.code !== 0) {
    return stop('not-repo', 'Thư mục đang mở không nằm trong một repo git.', ['git init', 'git clone <url>'], output(top));
  }
  const prefix = top.stdout.trim();
  const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.code === 0 ? head.stdout.trim() : undefined;
  const remotes = (await git(root, ['remote'])).stdout.split(/\r?\n/).filter(Boolean);
  const remote = branch ? await config(root, `branch.${branch}.remote`) : undefined;
  const merge = branch ? await config(root, `branch.${branch}.merge`) : undefined;
  const tracked = remote && merge && remotes.includes(remote) ? { remote, merge } : {};

  const scope = await scopeOf(root, prefix);
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
  if (status.code !== 0) return failed('git status', status);
  const changes: GitChange[] = [];
  let outside = 0;
  let conflict = false;
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const state = changeState(entry.slice(0, 2));
    const path = entry.slice(3);
    if (state === 'conflicted') conflict = true;
    if (inScope(scope, path)) changes.push({ path, state });
    else outside += 1;
  }
  for (const ref of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if ((await git(root, ['rev-parse', '--quiet', '--verify', ref])).code === 0) conflict = true;
  }
  const repo: Repo = { root, prefix, ...(branch ? { branch } : {}), remotes, ...tracked, scope, changes, outside, conflict, ahead: 0, behind: 0 };
  return tracked.remote ? { ...repo, ...(await counts(root)) } : repo;
}

/**
 * Checks an action can run: on a branch, no conflict, a remote and an upstream. With `fetch`, fetches the upstream's
 * remote first so ahead/behind are current.
 */
async function ready(repo: Repo, fetch: boolean): Promise<Repo | GitStop> {
  if (repo.conflict) {
    return stop(
      'conflict',
      'Repo đang có conflict, hoặc một lần merge/rebase chưa xong. Ứng dụng không tự giải quyết conflict: hãy xử lý trong terminal rồi bấm Làm mới.',
      ['git status'],
    );
  }
  if (!repo.branch) {
    return stop('detached', 'HEAD đang không ở nhánh nào (detached). Ứng dụng chỉ làm việc trên một nhánh: hãy chuyển về nhánh của bạn.', ['git switch <nhánh>']);
  }
  if (repo.remotes.length === 0) {
    return stop('no-remote', 'Repo chưa có remote nên không pull hay push được. Hãy thêm remote của team.', [
      'git remote add origin <url>',
      `git push --set-upstream origin ${repo.branch}`,
    ]);
  }
  if (!repo.remote) {
    return stop('no-upstream', `Nhánh ${repo.branch} chưa theo dõi nhánh nào trên remote. Hãy push nhánh này lần đầu trong terminal.`, [
      `git push --set-upstream ${repo.remotes[0]} ${repo.branch}`,
    ]);
  }
  if (!fetch) return repo;
  const fetched = await git(repo.root, ['fetch', '--quiet', repo.remote]);
  if (fetched.code !== 0) return failed(`git fetch ${repo.remote}`, fetched, [`git fetch ${repo.remote}`]);
  return { ...repo, ...(await counts(repo.root)) };
}

function diverged(repo: Repo): GitStop {
  return stop(
    'diverged',
    `Lịch sử ở máy và trên remote đã tách nhánh: ở máy có ${repo.ahead} commit chưa push, ${upstreamName(repo)} có ${repo.behind} commit mới. ` +
      'Ứng dụng không merge hay rebase nên đã dừng, working tree không đổi. Hãy hợp nhất trong terminal rồi bấm Làm mới.',
    ['git status', 'git log --oneline --graph --all -20', 'git pull'],
  );
}

/** Unpushed commits may only touch the scope: the app never pushes a path it would not have added. */
async function checkUnpushed(repo: Repo): Promise<GitStop | undefined> {
  const run = await git(repo.root, ['diff', '--name-only', '-z', '@{upstream}...HEAD']);
  if (run.code !== 0) return failed('git diff', run);
  const outside = run.stdout.split('\0').filter((path) => path && !inScope(repo.scope, path));
  if (outside.length === 0) return undefined;
  return stop(
    'outside-commits',
    `Có commit chưa push sửa file ngoài phạm vi của ứng dụng (${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}). ` +
      'Ứng dụng chỉ push commit đụng tới thư mục manifest và các file mà docs.yaml tham chiếu: hãy push trong terminal.',
    ['git log --stat @{upstream}..HEAD', 'git push'],
  );
}

async function push(repo: Repo): Promise<GitRun> {
  return git(repo.root, ['push', repo.remote!, `HEAD:${repo.merge!}`]);
}

type Action = (repo: Repo) => Promise<GitOutcome>;

let queue: Promise<unknown> = Promise.resolve();

/** Runs one git action at a time; a stop from an action (not from a status read) opens the terminal. */
function run(root: string, action: Action | undefined): Promise<Result<GitOutcome>> {
  const next = queue.then(async (): Promise<Result<GitOutcome>> => {
    let outcome: GitOutcome;
    try {
      const repo = await readRepoState(root);
      if ('reason' in repo) outcome = { kind: 'stopped', stop: repo };
      else outcome = action ? await action(repo) : { kind: 'ok', status: toStatus(repo) };
    } catch (error) {
      if (!(error instanceof GitMissing)) throw error;
      outcome = { kind: 'stopped', stop: stop('no-git', 'Không tìm thấy git trên máy. Hãy cài Git rồi mở lại ứng dụng.', ['winget install --id Git.Git -e']) };
    }
    if (action && outcome.kind === 'stopped' && outcome.stop.reason !== 'behind') {
      terminals.open({ kind: 'shell', cwd: root });
      outcome.stop.terminal = true;
    }
    return { ok: true, value: outcome };
  });
  queue = next.catch(() => undefined);
  return next;
}

/** Re-reads the status after an action, keeping its summary. */
async function after(root: string, summary: string): Promise<GitOutcome> {
  const repo = await readRepoState(root);
  if ('reason' in repo) return { kind: 'stopped', stop: repo };
  return { kind: 'ok', status: toStatus(repo), summary };
}

export function gitStatus(root: string): Promise<Result<GitOutcome>> {
  return run(root, undefined);
}

export function gitPull(root: string): Promise<Result<GitOutcome>> {
  return run(root, async (state) => {
    const repo = await ready(state, true);
    if ('reason' in repo) return { kind: 'stopped', stop: repo, status: toStatus(state) };
    if (repo.behind === 0) return { kind: 'ok', status: toStatus(repo), summary: 'Đã là bản mới nhất, không có gì để pull.' };
    if (repo.ahead > 0) return { kind: 'stopped', stop: diverged(repo), status: toStatus(repo) };
    const pulled = await git(repo.root, ['pull', '--ff-only', '--no-rebase', repo.remote!, repo.merge!]);
    if (pulled.code !== 0) {
      const stopped = failed('git pull --ff-only', pulled, ['git status', 'git pull --ff-only']);
      stopped.message += ' Working tree không đổi: git từ chối khi một file đang sửa ở máy cũng đổi trên remote. Hãy xử lý trong terminal.';
      return { kind: 'stopped', stop: stopped, status: toStatus(repo) };
    }
    return after(repo.root, `Đã pull ${repo.behind} commit từ ${upstreamName(repo)}.`);
  });
}

export function gitCommitPush(root: string, message: string): Promise<Result<GitOutcome>> {
  if (!message.trim()) return Promise.resolve({ ok: false, message: 'Hãy nhập message cho commit.' });
  return run(root, async (state) => {
    const repo = await ready(state, true);
    if ('reason' in repo) return { kind: 'stopped', stop: repo, status: toStatus(state) };
    if (repo.changes.length === 0) return { kind: 'ok', status: toStatus(repo), summary: 'Không có file nào trong phạm vi đã đổi, không có gì để commit.' };
    if (repo.behind > 0) {
      const stopped = stop('behind', `${upstreamName(repo)} có ${repo.behind} commit mới chưa có ở máy. Hãy bấm Pull trước, rồi Commit + Push lại.`);
      return { kind: 'stopped', stop: stopped, status: toStatus(repo) };
    }
    const unpushed = await checkUnpushed(repo);
    if (unpushed) return { kind: 'stopped', stop: unpushed, status: toStatus(repo) };

    // Exactly the changed files in scope, relative to the opened folder (git's cwd), taken literally.
    const paths = `${repo.changes.map((change) => change.path.slice(repo.prefix.length)).join('\0')}\0`;
    const pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul'];
    const added = await git(repo.root, ['--literal-pathspecs', 'add', '--all', ...pathspec], paths);
    if (added.code !== 0) return { kind: 'stopped', stop: failed('git add', added), status: toStatus(repo) };
    // --only commits these paths alone, even when something else was already staged.
    const committed = await git(repo.root, ['--literal-pathspecs', 'commit', '--only', '--quiet', '-m', message.trim(), ...pathspec], paths);
    if (committed.code !== 0) return { kind: 'stopped', stop: failed('git commit', committed), status: toStatus(repo) };
    const pushed = await push(repo);
    if (pushed.code !== 0) {
      const stopped = failed('git push', pushed, ['git status', 'git push']);
      stopped.message += ' Commit đã được tạo ở máy nhưng chưa lên remote.';
      return { kind: 'stopped', stop: stopped, status: toStatus(repo) };
    }
    return after(repo.root, `Đã commit và push ${repo.changes.length} file lên ${upstreamName(repo)}.`);
  });
}

export function gitPush(root: string): Promise<Result<GitOutcome>> {
  return run(root, async (state) => {
    const repo = await ready(state, true);
    if ('reason' in repo) return { kind: 'stopped', stop: repo, status: toStatus(state) };
    if (repo.ahead === 0) return { kind: 'ok', status: toStatus(repo), summary: 'Không có commit nào chưa push.' };
    if (repo.behind > 0) return { kind: 'stopped', stop: diverged(repo), status: toStatus(repo) };
    const unpushed = await checkUnpushed(repo);
    if (unpushed) return { kind: 'stopped', stop: unpushed, status: toStatus(repo) };
    const pushed = await push(repo);
    if (pushed.code !== 0) return { kind: 'stopped', stop: failed('git push', pushed, ['git status', 'git push']), status: toStatus(repo) };
    return after(repo.root, `Đã push ${repo.ahead} commit lên ${upstreamName(repo)}.`);
  });
}

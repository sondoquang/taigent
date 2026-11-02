// Taigent Desktop main process: one locked-down window (context isolation, sandbox, strict CSP, no navigation),
// served from the `app://` scheme, and the IPC handlers behind `window.taigent` (src/shared/api.ts).

import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import {
  type ApplyOutcome,
  type ApplyReport,
  CHANNELS,
  type AppState,
  type ItemRef,
  type LoginInput,
  type LoginStatus,
  type Plan,
  type ProjectSettingsInput,
  type RemoveItemRequest,
  type RepoInfo,
  type Result,
  type SaveItemRequest,
  type TicketCommentRequest,
  type TicketStatusRequest,
  type SaveWikiPageRequest,
  type VerdictChoice,
} from '../shared/api.ts';
import { buildView, changeReview, failure, messageOf, ProjectWatcher, pushBlockers, readBacklog, removeItem, saveItem, toFailure } from './project.ts';
import { headlessAgent, lastRepo, readRepo, rememberRepo, repoEnv, reviewerName, setHeadlessAgent } from './repo.ts';
import { loadCore, parseCliJson, runCli, taigentVersion } from './taigent.ts';
import { registerTerminalIpc, terminals } from './terminal.ts';
import { bootstrapProject, listTaigaProjects, readTaigaProject, saveProjectFile } from './taiga-projects.ts';
import { readTaigaReport } from './taiga-report.ts';
import { gitCommitPush, gitPull, gitPush, gitStatus } from './git.ts';
import { runSkill } from './headless.ts';
import { commentTicket, readMyTickets, setTicketStatus } from './tickets.ts';
import { readWiki, saveWikiPage, uploadWiki } from './wiki.ts';

const RENDERER_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'renderer');
const PRELOAD = join(fileURLToPath(new URL('.', import.meta.url)), 'preload.cjs');
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // xterm.js (terminal panel) styles its rows with <style> elements and style attributes. Scripts stay 'self' only,
  // and agent-written Markdown cannot use inline styles: DOMPurify drops <style> and style="" (markdown.ts).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

let repoRoot: string | undefined;
let window: BrowserWindow | undefined;
const watcher = new ProjectWatcher();

/** The opened repository; throws (shown by the renderer as a Failure through `handle`) when there is none. */
function requireRepo(): string {
  if (!repoRoot) throw new Error('Chưa mở thư mục repo.');
  return repoRoot;
}

async function openRepoAt(root: string): Promise<Result<RepoInfo>> {
  try {
    const info = await readRepo(root);
    repoRoot = root;
    watcher.close();
    await rememberRepo(root);
    return { ok: true, value: info };
  } catch (error) {
    return toFailure(error, 'Không mở được thư mục');
  }
}

async function serveRenderer(request: Request): Promise<Response> {
  const path = normalize(join(RENDERER_DIR, decodeURIComponent(new URL(request.url).pathname)));
  if (!path.startsWith(RENDERER_DIR + sep)) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(path);
    return new Response(body, {
      headers: { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Content-Security-Policy': CSP },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'Taigent Desktop',
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-redirect', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  void win.loadURL('app://taigent/index.html');
  return win;
}

/** `whoami --json`: who the CLI would act as on Taiga. */
async function whoami(): Promise<LoginStatus> {
  const root = repoRoot ?? app.getPath('home');
  const run = await runCli(['whoami', '--json'], root);
  const { value, error } = parseCliJson<{ apiUrl: string; user: { username: string }; credentials: { source: string } }>(run);
  if (value) return { loggedIn: true, apiUrl: value.apiUrl, username: value.user.username, source: value.credentials.source };
  if (error?.kind === 'login') return { loggedIn: false, message: 'Chưa đăng nhập Taiga.' };
  return { loggedIn: false, message: `Không kiểm tra được đăng nhập: ${error?.message ?? 'lỗi không rõ'}` };
}

/** The URL typed in the login form, as `taigent login` takes it: http(s), no credentials; a bare host gets /api/v1. */
function loginApiUrl(raw: string): string {
  const text = raw.trim();
  if (!URL.canParse(text)) throw new Error(`"${text}" không phải URL (ví dụ https://taiga.example.com/api/v1).`);
  const url = new URL(text);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('URL API Taiga phải bắt đầu bằng https:// hoặc http://.');
  if (url.username || url.password) throw new Error('URL API Taiga không được chứa thông tin đăng nhập (user:password@).');
  return `${url.origin}${url.pathname === '/' ? '/api/v1' : url.pathname}`.replace(/\/+$/, '');
}

/** Logs in like `taigent login`: the password goes to Taiga once and is never stored or logged. */
async function login(input: LoginInput): Promise<Result<LoginStatus>> {
  const core = await loadCore();
  const secrets = new core.secrets.Secrets();
  secrets.add(input.password);
  let apiUrl: string;
  try {
    apiUrl = loginApiUrl(input.apiUrl);
  } catch (error) {
    return failure(messageOf(error));
  }
  const username = input.username.trim();
  if (!username) return failure('Hãy nhập tên đăng nhập hoặc email.');
  if (!input.password) return failure('Hãy nhập mật khẩu.');
  const env = repoRoot ? repoEnv(repoRoot) : process.env;
  try {
    const stored = await core.login.storeLogin({ env, apiUrl, username, password: input.password, secrets });
    return { ok: true, value: { loggedIn: true, apiUrl: stored.record.apiUrl, username: stored.record.username, source: 'login' } };
  } catch (error) {
    if (error instanceof core.client.TaigaAuthError && error.credential === 'password') {
      return failure('Taiga từ chối tên đăng nhập hoặc mật khẩu.');
    }
    const detail = secrets.redact(messageOf(error));
    if (error instanceof core.client.TaigaError) return failure(`Không đăng nhập được vào ${apiUrl}.`, { detail });
    return failure('Không lưu được đăng nhập.', { detail });
  }
}

async function logout(): Promise<Result<LoginStatus>> {
  const core = await loadCore();
  const secrets = new core.secrets.Secrets();
  try {
    await core.login.removeLogin(repoRoot ? repoEnv(repoRoot) : process.env, secrets);
  } catch (error) {
    return failure('Đã xoá đăng nhập trên máy này, nhưng không thu hồi được token trên Taiga.', {
      detail: secrets.redact(messageOf(error)),
    });
  }
  return { ok: true, value: await whoami() };
}

async function plan(slug: string): Promise<Result<Plan>> {
  const run = await runCli(['plan', '--project', slug, '--json'], requireRepo());
  const { value, error } = parseCliJson<Plan>(run);
  if (value && (run.code === 0 || run.code === 3)) return { ok: true, value };
  return failure('Không lấy được thay đổi từ Taiga.', { detail: error?.message, issues: error?.issues });
}

/**
 * "Đẩy lên Taiga": refuses while the project is blocked, reads the plan, asks for explicit approval in a native
 * dialog listing what will change and what is not reviewed, then runs `apply --yes`.
 */
async function apply(slug: string): Promise<Result<ApplyOutcome>> {
  const root = requireRepo();
  const view = await buildView(root, slug);
  if (!view.ok) return view;
  const reasons = pushBlockers(view.value);
  if (reasons.length > 0) return { ok: true, value: { status: 'blocked', reasons } };
  const planned = await plan(slug);
  if (!planned.ok) return planned;
  if (!planned.value.changes) return { ok: true, value: { status: 'no-changes', plan: planned.value } };

  const { summary } = view.value.preview;
  const counts = planned.value.summary;
  const issueOps = planned.value.operations.filter((op) => op.type === 'issue');
  const detail = [
    `Dự án: ${slug}`,
    `Tạo mới: ${counts.create} mục`,
    `Cập nhật: ${counts.update} mục`,
    `Trong đó issue: tạo mới ${issueOps.filter((op) => op.action === 'create').length}, cập nhật ${issueOps.filter((op) => op.action === 'update').length}`,
    `Gắn story vào epic: ${counts.link}`,
    '',
    `Chưa duyệt: ${summary.unreviewed} mục`,
    `Đã đổi sau khi duyệt: ${summary.stale} mục`,
    `Cần sửa (đã xử lý góp ý): ${summary.changes} mục`,
  ].join('\n');
  const { response } = await dialog.showMessageBox(window!, {
    type: summary.unreviewed + summary.stale > 0 ? 'warning' : 'question',
    title: 'Đẩy lên Taiga',
    message: 'Ghi các thay đổi này lên Taiga?',
    detail,
    buttons: ['Đẩy lên Taiga', 'Huỷ'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: true, value: { status: 'cancelled' } };

  const run = await runCli(['apply', '--project', slug, '--yes', '--json'], root);
  const { value, error } = parseCliJson<ApplyReport>(run);
  if (value && run.code === 0) return { ok: true, value: { status: 'applied', report: value } };
  return failure('Đẩy lên Taiga thất bại; các mục đã ghi được lưu trong state.json, chạy lại sẽ tiếp tục.', {
    detail: error?.message,
    issues: error?.issues,
  });
}

/** Wraps a handler so an unexpected throw reaches the renderer as a Failure, not as a rejected invoke. */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...(args as A));
    } catch (error) {
      return toFailure(error, 'Lỗi');
    }
  });
}

function registerIpc(): void {
  handle(CHANNELS.getState, async (): Promise<AppState> => {
    const remembered = repoRoot ?? (await lastRepo());
    const opened = remembered ? await openRepoAt(remembered) : undefined;
    return {
      repo: opened?.ok ? opened.value : undefined,
      reviewer: await reviewerName(repoRoot),
      versions: { app: app.getVersion(), electron: process.versions.electron, node: process.versions.node, taigent: taigentVersion() },
    };
  });
  handle(CHANNELS.openRepo, async () => {
    const picked = await dialog.showOpenDialog(window!, { title: 'Mở thư mục repo', properties: ['openDirectory'] });
    if (picked.canceled || !picked.filePaths[0]) return undefined;
    return openRepoAt(picked.filePaths[0]);
  });
  handle(CHANNELS.refreshRepo, async () => openRepoAt(requireRepo()));
  handle(CHANNELS.openProject, async (slug: string) => {
    const root = requireRepo();
    const view = await buildView(root, slug);
    watcher.watch(root, slug, (next) => window?.webContents.send(CHANNELS.projectChanged, next));
    return view;
  });
  handle(CHANNELS.setVerdict, async (slug: string, key: string, verdict: VerdictChoice) =>
    changeReview(requireRepo(), slug, key, { kind: 'verdict', verdict }),
  );
  handle(CHANNELS.addComment, async (slug: string, key: string, text: string) => {
    if (!text.trim()) return failure('Góp ý đang trống.');
    return changeReview(requireRepo(), slug, key, { kind: 'comment', text: text.trim() });
  });
  handle(CHANNELS.whoami, whoami);
  handle(CHANNELS.login, login);
  handle(CHANNELS.logout, logout);
  handle(CHANNELS.plan, plan);
  handle(CHANNELS.apply, apply);
  handle(CHANNELS.openExternal, async (url: string) => {
    if (URL.canParse(url) && ['https:', 'http:'].includes(new URL(url).protocol)) await shell.openExternal(url);
  });
  handle(CHANNELS.readBacklog, async (slug: string, item?: ItemRef) => readBacklog(requireRepo(), slug, item));
  handle(CHANNELS.saveItem, async (slug: string, request: SaveItemRequest) => saveItem(requireRepo(), slug, request));
  handle(CHANNELS.removeItem, async (slug: string, request: RemoveItemRequest) => removeItem(requireRepo(), slug, request));
  handle(CHANNELS.readWiki, async (slug: string) => readWiki(requireRepo(), slug));
  handle(CHANNELS.saveWikiPage, async (slug: string, request: SaveWikiPageRequest) => saveWikiPage(requireRepo(), slug, request));
  handle(CHANNELS.uploadWiki, async (slug: string) => uploadWiki(requireRepo(), slug, window!));
  handle(CHANNELS.listTaigaProjects, async () => listTaigaProjects(requireRepo()));
  handle(CHANNELS.readTaigaProject, async (slug: string) => readTaigaProject(requireRepo(), slug));
  handle(CHANNELS.saveProjectSettings, async (input: ProjectSettingsInput) => saveProjectFile(requireRepo(), input));
  handle(CHANNELS.bootstrapProject, async (slug: string) => bootstrapProject(requireRepo(), slug, window!));
  handle(CHANNELS.readTaigaReport, async (slug: string) => readTaigaReport(requireRepo(), slug));
  handle(CHANNELS.gitStatus, async () => gitStatus(requireRepo()));
  handle(CHANNELS.gitPull, async () => gitPull(requireRepo()));
  handle(CHANNELS.gitCommitPush, async (message: string) => gitCommitPush(requireRepo(), String(message)));
  handle(CHANNELS.gitPush, async () => gitPush(requireRepo()));
  handle(CHANNELS.headlessAgent, headlessAgent);
  handle(CHANNELS.setHeadlessAgent, async (agent: unknown) => ({ ok: true, value: await setHeadlessAgent(agent) }));
  handle(CHANNELS.runSkill, async (request: unknown) =>
    runSkill(requireRepo(), request, window!, (end) => {
      if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.skillRunEnded, end);
    }),
  );
  // Tickets need no repository; with one open, its .env (TAIGA_*) applies, as for whoami.
  handle(CHANNELS.readMyTickets, async (from: string, to: string) => readMyTickets(repoRoot ?? app.getPath('home'), String(from), String(to)));
  handle(CHANNELS.setTicketStatus, async (request: TicketStatusRequest) => setTicketStatus(repoRoot ?? app.getPath('home'), request, window!));
  handle(CHANNELS.commentTicket, async (request: TicketCommentRequest) => commentTicket(repoRoot ?? app.getPath('home'), request, window!));
}

app.enableSandbox();

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  protocol.handle('app', serveRenderer);
  registerIpc();
  registerTerminalIpc(() => window, requireRepo);
  window = createWindow();
});

app.on('window-all-closed', () => {
  watcher.close();
  app.quit();
});

// Quitting kills every terminal tab's process tree, so no shell or agent outlives the app.
app.on('will-quit', () => terminals.killAll());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

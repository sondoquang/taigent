// The Setup repo section (spec #35, ticket #40): a new repository, a clone or an existing one; `taigent init` of the
// app's own taigent; `npm install` in a terminal tab; the checklist of tools (git, claude, codex, omp), the Taiga
// login and the reminder to approve the `taiga` MCP server. Also the top-bar suggestion shown when no repository is
// open, when the opened one has no Taigent, or when its Taigent files are older than the app's. Every action runs in
// the main process (src/main/setup.ts, src/main/tools.ts); this module only shows outcomes.

import {
  type Failure,
  type InitFile,
  type InitReport,
  type LoginStatus,
  type RepoInfo,
  type Result,
  SETUP_TOOLS,
  type SetupStatus,
  type SetupTool,
  type TaigentApi,
  type ToolCheck,
} from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { currentSection, onSectionChange, showSection } from './navigation.ts';

/** What the section borrows from renderer.ts. */
export interface SetupDeps {
  api: TaigentApi;
  failureBlock(failure: Failure): HTMLElement;
  /** The opened repository's folder, or undefined. */
  repoRoot(): string | undefined;
  /** Shows a repository the wizard opened, as the top bar's "Mở thư mục repo…" does. */
  useRepo(result: Result<RepoInfo>): void;
  /** Opens the login dialog. */
  login(): void;
  /** Reads the login again (`whoami`); `setupLoginChanged` follows. */
  refreshLogin(): Promise<void>;
  loginStatus(): LoginStatus | undefined;
}

const FILE_STATUS: Record<InitFile['status'], string> = { created: 'Tạo mới', updated: 'Cập nhật', unchanged: 'Giữ nguyên', removed: 'Xoá' };
const TOOL_NAME: Record<SetupTool, string> = { git: 'git', claude: 'claude (Claude Code)', codex: 'codex (Codex CLI)', omp: 'omp (oh-my-pi)' };

let deps: SetupDeps;
let parent: string | undefined;
/** The opened repository's Taigent state; undefined while it is read or without a repository. */
let status: SetupStatus | undefined;
let statusRun = 0;
let tools: ToolCheck[] | undefined;
let toolsChecking = false;
let loginChecking = false;
let busy = false;
let nameFollowsUrl = true;
/** The terminal tab of the last `npm install` the wizard started. */
let npmTab: number | undefined;

function renderBanner(): void {
  const banner = byId('setup-banner');
  const root = deps.repoRoot();
  const suggestion: [string, string, string] | undefined = !root
    ? ['no-repo', 'Chưa mở repo.', 'Setup repo']
    : status?.state === 'none'
      ? ['none', 'Repo chưa cài Taigent.', 'Cài Taigent']
      : status?.state === 'outdated'
        ? ['outdated', 'Taigent trong repo cũ hơn ứng dụng.', 'Chạy lại init']
        : undefined;
  if (!suggestion) {
    banner.hidden = true;
    delete banner.dataset.state;
    return;
  }
  const [state, text, action] = suggestion;
  banner.dataset.state = state;
  byId('setup-banner-text').textContent = text;
  byId('setup-banner-action').textContent = action;
  banner.title = state === 'outdated' ? `init sẽ đổi ${status?.changes.length} file` : '';
  banner.hidden = currentSection() === 'setup';
}

function renderStatus(): void {
  const element = byId('setup-status');
  const root = deps.repoRoot();
  const state = !root ? 'no-repo' : (status?.state ?? 'checking');
  element.dataset.state = state;
  const line = (text: string, ...rest: (string | Node)[]) => h('p', {}, text, ...rest);
  switch (state) {
    case 'no-repo':
      element.replaceChildren(line('Chưa mở repo. Tạo, clone hoặc mở một repo ở bước 1.'));
      return;
    case 'checking':
      element.replaceChildren(line('Đang kiểm tra repo (taigent init --dry-run)…'));
      return;
    case 'none':
      element.replaceChildren(line(`Repo ${root} chưa cài Taigent. Bấm “Cài Taigent vào repo”.`));
      return;
    case 'current':
      element.replaceChildren(line(`Repo đã cài Taigent, cùng version với ứng dụng (taigent ${status?.taigent}). Không cần setup lại.`));
      return;
    case 'outdated':
      element.replaceChildren(
        line(`Taigent trong repo cũ hơn hoặc khác bản của ứng dụng (taigent ${status?.taigent}). Chạy lại init sẽ đổi ${status?.changes.length} file:`),
        h('ul', { class: 'setup-changes' }, ...(status?.changes ?? []).map((file) => h('li', {}, h('code', {}, file.path), ` ${FILE_STATUS[file.status]}`))),
      );
      return;
    default:
      element.replaceChildren(line(`Không kiểm tra được repo: ${status?.message ?? 'lỗi không rõ'}`));
  }
}

function renderButtons(): void {
  const root = deps.repoRoot();
  for (const id of ['setup-parent', 'setup-new-create', 'setup-clone-go', 'setup-open']) byId<HTMLButtonElement>(id).disabled = busy;
  const init = byId<HTMLButtonElement>('setup-init');
  init.disabled = busy || !root || !status;
  init.textContent = status?.state === 'none' || !status ? 'Cài Taigent vào repo' : 'Chạy lại init';
  byId<HTMLButtonElement>('setup-npm').disabled = busy || !root;
  byId<HTMLButtonElement>('setup-recheck').disabled = toolsChecking || loginChecking;
}

function toolItem(tool: SetupTool): HTMLElement {
  const check = toolsChecking ? undefined : tools?.find((entry) => entry.tool === tool);
  const name = TOOL_NAME[tool];
  if (!check) return h('li', { 'data-item': tool, 'data-state': 'checking' }, h('span', { class: 'setup-mark' }, '…'), `${name}: đang kiểm tra…`);
  const where = check.path && h('span', { class: 'muted setup-where' }, check.path);
  const install = h(
    'div',
    { class: 'setup-install' },
    'Lệnh cài: ',
    h('code', {}, check.install),
    h('button', { class: 'btn small', type: 'button', 'data-install': tool, onclick: () => void runInstall(tool) }, 'Chạy trong terminal'),
  );
  switch (check.state) {
    case 'ok':
      return h('li', { 'data-item': tool, 'data-state': 'ok' }, h('span', { class: 'setup-mark ok' }, '✓'), `${name} `, h('span', { class: 'setup-version' }, check.version ?? ''), ' ', where);
    case 'missing':
      return h('li', { 'data-item': tool, 'data-state': 'missing' }, h('span', { class: 'setup-mark bad' }, '✗'), `${name}: Chưa cài`, install);
    case 'found':
      return h('li', { 'data-item': tool, 'data-state': 'found' }, h('span', { class: 'setup-mark ok' }, '✓'), `${name}: ${check.message ?? ''} `, where);
    default:
      return h('li', { 'data-item': tool, 'data-state': check.state }, h('span', { class: 'setup-mark warn' }, '!'), `${name}: ${check.message ?? 'lỗi'} `, where, install);
  }
}

function loginItem(): HTMLElement {
  const login = deps.loginStatus();
  if (loginChecking || !login) return h('li', { 'data-item': 'login', 'data-state': 'checking' }, h('span', { class: 'setup-mark' }, '…'), 'Đăng nhập Taiga: đang kiểm tra…');
  if (login.loggedIn) {
    return h('li', { 'data-item': 'login', 'data-state': 'ok' }, h('span', { class: 'setup-mark ok' }, '✓'), `Đăng nhập Taiga: ${login.username} (${login.apiUrl})`);
  }
  return h(
    'li',
    { 'data-item': 'login', 'data-state': 'missing' },
    h('span', { class: 'setup-mark bad' }, '✗'),
    `${login.message ?? 'Chưa đăng nhập Taiga.'} `,
    h('button', { id: 'setup-login', class: 'btn small primary', type: 'button', onclick: () => deps.login() }, 'Đăng nhập'),
    h('span', { class: 'muted' }, ' Dùng chung với taigent login, nên agent trong terminal cũng dùng được.'),
  );
}

function renderChecklist(): void {
  byId('setup-checklist').replaceChildren(
    ...SETUP_TOOLS.map(toolItem),
    loginItem(),
    h(
      'li',
      { 'data-item': 'mcp', 'data-state': 'reminder' },
      h('span', { class: 'setup-mark warn' }, '!'),
      'Lần đầu mở ',
      h('code', {}, 'claude'),
      ' trong repo, Claude Code hỏi có dùng MCP server ',
      h('code', {}, 'taiga'),
      ' (khai báo trong ',
      h('code', {}, '.mcp.json'),
      ') không: hãy chọn dùng, để agent đọc được Taiga. Kiểm tra lại bằng ',
      h('code', {}, 'claude mcp get taiga'),
      '. Codex chỉ nạp ',
      h('code', {}, '.codex/config.toml'),
      ' của repo khi bạn trust project.',
    ),
  );
}

function render(): void {
  renderBanner();
  renderStatus();
  renderButtons();
  renderChecklist();
}

function initTable(report: InitReport): HTMLElement {
  const count = (state: InitFile['status']) => report.files.filter((file) => file.status === state).length;
  return h(
    'div',
    {},
    h(
      'p',
      {},
      `taigent init: ${count('created')} file tạo mới, ${count('updated')} cập nhật, ${count('removed')} xoá, ${count('unchanged')} giữ nguyên.`,
      count('unchanged') < report.files.length ? ' Hãy commit các file đã đổi để cả team dùng chung.' : '',
    ),
    h(
      'details',
      {},
      h('summary', {}, `Xem ${report.files.length} file`),
      h(
        'table',
        { class: 'setup-files' },
        h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Trạng thái'))),
        h(
          'tbody',
          {},
          ...report.files.map((file) =>
            h('tr', { 'data-path': file.path, 'data-status': file.status, class: file.status }, h('td', {}, h('code', {}, file.path)), h('td', {}, FILE_STATUS[file.status])),
          ),
        ),
      ),
    ),
  );
}

function showInit(result: Result<InitReport>): void {
  byId('setup-init-result').replaceChildren(result.ok ? initTable(result.value) : deps.failureBlock(result));
}

function showRepoResult(...content: HTMLElement[]): void {
  byId('setup-repo-result').replaceChildren(...content);
}

async function withBusy(fn: () => Promise<void>): Promise<void> {
  busy = true;
  renderButtons();
  try {
    await fn();
  } finally {
    busy = false;
    renderButtons();
  }
}

/** Reads the opened repository's Taigent state; a later read or another repository wins. */
async function loadStatus(): Promise<void> {
  const run = ++statusRun;
  status = undefined;
  render();
  if (!deps.repoRoot()) return;
  const result = await deps.api.setupStatus();
  if (run !== statusRun) return;
  status = result.ok ? result.value : { state: 'unavailable', changes: [], taigent: '', message: result.message };
  render();
}

async function checkTools(): Promise<void> {
  toolsChecking = true;
  loginChecking = true;
  render();
  const login = deps.refreshLogin().finally(() => {
    loginChecking = false;
    renderChecklist();
  });
  const [checked] = await Promise.all([deps.api.checkTools(), login]);
  tools = checked;
  toolsChecking = false;
  render();
}

async function runInstall(tool: SetupTool): Promise<void> {
  const result = await deps.api.installTool(tool);
  if (!result.ok) showRepoResult(deps.failureBlock(result));
}

async function createRepo(event: Event): Promise<void> {
  event.preventDefault();
  await withBusy(async () => {
    showRepoResult(h('p', { class: 'muted' }, 'Đang tạo repo và cài Taigent…'));
    byId('setup-init-result').replaceChildren();
    const result = await deps.api.createRepo({ parent: parent ?? '', name: byId<HTMLInputElement>('setup-new-name').value });
    if (!result.ok) return showRepoResult(deps.failureBlock(result));
    deps.useRepo({ ok: true, value: result.value.repo });
    showRepoResult(h('p', {}, `Đã tạo repo ${result.value.repo.root} (git init, thư mục taiga/).`));
    showInit(result.value.init);
  });
}

async function cloneRepo(event: Event): Promise<void> {
  event.preventDefault();
  await withBusy(async () => {
    showRepoResult(h('p', { class: 'muted' }, 'Đang clone…'));
    const result = await deps.api.cloneRepo({
      url: byId<HTMLInputElement>('setup-clone-url').value,
      parent: parent ?? '',
      name: byId<HTMLInputElement>('setup-clone-name').value,
    });
    if (!result.ok) return showRepoResult(deps.failureBlock(result));
    byId('setup-init-result').replaceChildren();
    deps.useRepo(result);
    showRepoResult(h('p', {}, `Đã clone vào ${result.value.root}.`));
  });
}

async function runInit(): Promise<void> {
  await withBusy(async () => {
    byId('setup-init-result').replaceChildren(h('p', { class: 'muted' }, 'Đang chạy taigent init…'));
    showInit(await deps.api.runInit());
  });
  await loadStatus();
}

async function runNpmInstall(): Promise<void> {
  const result = await deps.api.runNpmInstall();
  if (!result.ok) {
    byId('setup-npm-result').textContent = result.message;
    return;
  }
  npmTab = result.value.id;
  byId('setup-npm-result').textContent = 'Đang chạy npm install trong tab terminal…';
}

/** The folder name a clone of `url` gets: its last path segment without `.git`. */
function repoName(url: string): string {
  return (url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '').replace(/\.git$/i, '');
}

/** Another repository opened (top bar or wizard): reads its Taigent state again. */
export function setupRepoChanged(): void {
  void loadStatus();
}

/** The Taiga login was read again. */
export function setupLoginChanged(): void {
  renderChecklist();
}

export function mountSetup(borrowed: SetupDeps): void {
  deps = borrowed;
  byId('setup-banner-action').addEventListener('click', () => showSection('setup'));
  byId('setup-parent').addEventListener('click', async () => {
    const picked = await deps.api.pickParentFolder();
    if (picked === undefined) return;
    parent = picked;
    byId('setup-parent-path').textContent = picked;
  });
  byId('setup-new-form').addEventListener('submit', (event) => void createRepo(event));
  byId('setup-clone-form').addEventListener('submit', (event) => void cloneRepo(event));
  const url = byId<HTMLInputElement>('setup-clone-url');
  const name = byId<HTMLInputElement>('setup-clone-name');
  url.addEventListener('input', () => {
    if (nameFollowsUrl) name.value = repoName(url.value);
  });
  name.addEventListener('input', () => (nameFollowsUrl = name.value === ''));
  byId('setup-open').addEventListener('click', async () => {
    const result = await deps.api.openRepo();
    if (result) deps.useRepo(result);
  });
  byId('setup-init').addEventListener('click', () => void runInit());
  byId('setup-npm').addEventListener('click', () => void runNpmInstall());
  byId('setup-recheck').addEventListener('click', () => void checkTools());
  deps.api.terminal.onExit((id, exit) => {
    if (id !== npmTab) return;
    byId('setup-npm-result').textContent = exit.cancelled
      ? 'npm install đã bị huỷ.'
      : exit.exitCode === 0
        ? 'npm install xong (mã 0).'
        : `npm install lỗi (mã ${exit.exitCode}): xem output trong tab terminal.`;
  });
  onSectionChange((section) => {
    renderBanner();
    if (section === 'setup' && !tools && !toolsChecking) void checkTools();
  });
  render();
}

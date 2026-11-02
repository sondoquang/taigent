// The Git section: the changed files in scope (the manifests folder and what docs.yaml references), Pull, Commit +
// Push and Push. Every git command runs in the main process (src/main/git.ts); this module only shows outcomes.

import type { Failure, GitChange, GitOutcome, GitStatus, Result, TaigentApi } from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { currentSection, onSectionChange } from './navigation.ts';

/** What the section borrows from renderer.ts. */
export interface GitDeps {
  api: TaigentApi;
  failureBlock(failure: Failure): HTMLElement;
  toast(message: string, kind?: 'info' | 'error'): void;
  hasRepo(): boolean;
}

const STATE_LABEL: Record<GitChange['state'], string> = {
  modified: 'Sửa',
  added: 'Thêm',
  deleted: 'Xoá',
  untracked: 'Mới',
  conflicted: 'Conflict',
};

let deps: GitDeps | undefined;
let busy = false;
let status: GitStatus | undefined;

function renderButtons(): void {
  const off = busy || !deps?.hasRepo();
  for (const id of ['git-refresh', 'git-pull', 'git-push', 'git-commit-push']) byId<HTMLButtonElement>(id).disabled = off;
}

function renderStatus(): void {
  const overview = byId('git-overview');
  const files = byId('git-files');
  const outside = byId('git-outside');
  byId('git-files-empty').hidden = !status || status.changes.length > 0;
  if (!status) {
    files.replaceChildren();
    outside.textContent = '';
    overview.replaceChildren(h('p', { class: 'muted' }, deps!.hasRepo() ? 'Chưa đọc được trạng thái git.' : 'Chưa mở repo.'));
    return;
  }
  const sync = status.upstream
    ? `${status.upstream} · ${status.ahead} commit chưa push · ${status.behind} commit mới trên remote (theo lần fetch gần nhất)`
    : 'chưa theo dõi nhánh nào trên remote';
  overview.replaceChildren(
    h('p', {}, 'Nhánh ', h('strong', {}, status.branch ?? '(detached HEAD)'), ` → ${sync}`),
    h(
      'p',
      { class: 'muted' },
      'Phạm vi: ',
      ...(status.scope.length > 0
        ? status.scope.flatMap((path, index) => [index > 0 ? ', ' : '', h('code', {}, path)])
        : ['không có (thư mục manifest nằm ngoài repo).']),
    ),
  );
  files.replaceChildren(
    ...(status.changes.length > 0
      ? status.changes.map((change) =>
          h('li', { 'data-path': change.path, class: change.state }, h('span', { class: 'git-state' }, STATE_LABEL[change.state]), h('code', {}, change.path)),
        )
      : []),
  );
  outside.textContent = status.outside > 0 ? `${status.outside} file đã đổi ngoài phạm vi: ứng dụng không bao giờ commit hay push chúng.` : '';
}

function showOutcome(title: string, result: Result<GitOutcome>): void {
  const { failureBlock } = deps!;
  const target = byId('git-result');
  const time = h('p', { class: 'muted' }, new Date().toLocaleTimeString('vi-VN'));
  if (!result.ok) {
    target.replaceChildren(h('h2', {}, title), time, failureBlock(result));
    return;
  }
  const outcome = result.value;
  status = outcome.status ?? status;
  renderStatus();
  if (outcome.kind === 'ok') {
    target.replaceChildren(...(outcome.summary ? [h('h2', {}, title), time, h('p', {}, outcome.summary)] : []));
    return;
  }
  const { stop } = outcome;
  target.replaceChildren(
    h(
      'div',
      {},
      h('h2', {}, `${title}: đã dừng`),
      time,
      h('p', { class: 'error' }, stop.message),
      stop.terminal && h('p', {}, 'Đã mở một tab terminal ở repo để bạn tiếp tục.'),
      stop.commands.length > 0 && h('p', {}, 'Lệnh gợi ý, chạy trong terminal ở repo:'),
      stop.commands.length > 0 && h('pre', { class: 'detail-text' }, stop.commands.join('\n')),
      stop.detail && h('pre', { class: 'detail-text' }, stop.detail),
    ),
  );
}

async function act(title: string, call: () => Promise<Result<GitOutcome>>): Promise<void> {
  if (!deps || busy || !deps.hasRepo()) return;
  busy = true;
  renderButtons();
  byId('git-result').replaceChildren(h('p', { class: 'muted' }, `Đang chạy ${title}…`));
  try {
    const result = await call();
    showOutcome(title, result);
    if (result.ok && result.value.kind === 'ok' && result.value.summary) deps.toast(result.value.summary);
  } finally {
    busy = false;
    renderButtons();
  }
}

/** Reads the status again when the section shows; otherwise forgets it until the section shows. */
export async function refreshGit(): Promise<void> {
  if (!deps) return;
  if (!deps.hasRepo() || currentSection() !== 'git') {
    status = undefined;
    renderStatus();
    renderButtons();
    return;
  }
  const result = await deps.api.gitStatus();
  if (!result.ok || result.value.kind === 'stopped') {
    status = undefined;
    showOutcome('Trạng thái git', result);
  } else {
    status = result.value.status;
    renderStatus();
  }
  renderButtons();
}

/** Another repository opened: forgets the last outcome, which belonged to the previous one, and reads again. */
export function gitRepoChanged(): void {
  if (!deps) return;
  byId('git-result').replaceChildren();
  void refreshGit();
}

export function wireGit(borrowed: GitDeps): void {
  deps = borrowed;
  const { api } = borrowed;
  onSectionChange((section) => {
    if (section === 'git') void refreshGit();
  });
  byId('git-refresh').addEventListener('click', () => void act('Làm mới', () => api.gitStatus()));
  byId('git-pull').addEventListener('click', () => void act('Pull', () => api.gitPull()));
  byId('git-push').addEventListener('click', () => void act('Push', () => api.gitPush()));
  byId<HTMLFormElement>('git-commit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = byId<HTMLInputElement>('git-message');
    void act('Commit + Push', () => api.gitCommitPush(message.value)).then(() => {
      if (status && status.changes.length === 0) message.value = '';
    });
  });
  renderStatus();
  renderButtons();
}

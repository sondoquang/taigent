// The Git section: the changed files in scope (the manifests folder and what docs.yaml references), Pull, Commit +
// Push and Push. Every git command runs in the main process (src/main/git.ts); this module only shows outcomes.

import type { Failure, GitChange, GitOutcome, GitStatus, Result, TaigentApi } from '../shared/api.ts';
import { currentSection, onSectionChange } from './navigation.ts';

type Child = string | false | undefined | null | Node;
type ElementBuilder = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, string | boolean | ((event: Event) => void)>,
  ...children: Child[]
) => HTMLElementTagNameMap[K];

/** What the section borrows from renderer.ts. */
export interface GitDeps {
  api: TaigentApi;
  h: ElementBuilder;
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

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  // index.html declares every id this module asks for, with the element type the caller names.
  const typed = found as T;
  return typed;
}

function renderButtons(): void {
  const off = busy || !deps?.hasRepo();
  for (const id of ['git-refresh', 'git-pull', 'git-push', 'git-commit-push']) element<HTMLButtonElement>(id).disabled = off;
}

function renderStatus(): void {
  const { h } = deps!;
  const overview = element('git-overview');
  const files = element('git-files');
  const outside = element('git-outside');
  element('git-files-empty').hidden = !status || status.changes.length > 0;
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
  const { h, failureBlock } = deps!;
  const target = element('git-result');
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
      stop.terminal && h('p', {}, 'Đã mở thư mục repo để bạn tiếp tục trong terminal.'),
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
  element('git-result').replaceChildren(deps.h('p', { class: 'muted' }, `Đang chạy ${title}…`));
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
  element('git-result').replaceChildren();
  void refreshGit();
}

export function wireGit(borrowed: GitDeps): void {
  deps = borrowed;
  const { api } = borrowed;
  onSectionChange((section) => {
    if (section === 'git') void refreshGit();
  });
  element('git-refresh').addEventListener('click', () => void act('Làm mới', () => api.gitStatus()));
  element('git-pull').addEventListener('click', () => void act('Pull', () => api.gitPull()));
  element('git-push').addEventListener('click', () => void act('Push', () => api.gitPush()));
  element<HTMLFormElement>('git-commit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const message = element<HTMLInputElement>('git-message');
    void act('Commit + Push', () => api.gitCommitPush(message.value)).then(() => {
      if (status && status.changes.length === 0) message.value = '';
    });
  });
  renderStatus();
  renderButtons();
}

// Taigent Desktop UI: the navigation shell (navigation.ts) with the Backlog section (tree, item detail and its
// review), the Thay đổi section (plan and push to Taiga) and the Git section (git.ts). Everything it knows comes
// through `window.taigent` (preload); it never reaches the file system or the network itself.

import type {
  AppState,
  ApplyOutcome,
  Failure,
  LoginStatus,
  Plan,
  PreviewEpic,
  PreviewIssue,
  PreviewItem,
  PreviewStory,
  ProjectView,
  RepoInfo,
  Result,
  TaigentApi,
  VerdictChoice,
} from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { itemActions, mountForms } from './forms.ts';
import { renderMarkdown } from './markdown.ts';
import { currentSection, onSectionChange, showSection, wireNavigation } from './navigation.ts';
import { mountTaigaProjects } from './taiga-projects.ts';
import { gitRepoChanged, wireGit } from './git.ts';
import { mountMyTickets } from './my-tickets.ts';
import { wireTerminal } from './terminal.ts';

declare global {
  interface Window {
    taigent: TaigentApi;
  }
}

type Filter = 'all' | 'unreviewed' | 'changes' | 'stale';

/** A row of the Backlog tree: an epic-tree item with its parents, or an issue (no parent). */
interface TreeNode {
  item: PreviewItem;
  depth: number;
  epic?: PreviewEpic;
  story?: PreviewStory;
}

const api = window.taigent;
const state: {
  repo?: RepoInfo;
  view?: ProjectView;
  selected?: string;
  filter: Filter;
  login?: LoginStatus;
  busy: boolean;
} = { filter: 'all', busy: false };
const drafts = new Map<string, string>();

// ---- status vocabulary ----------------------------------------------------------------------------------------

const TYPE_LABEL: Record<PreviewItem['type'], string> = { epic: 'Epic', story: 'Story', task: 'Task', issue: 'Issue' };

function reviewStatus(item: PreviewItem): { label: string; css: string } {
  if (item.review.stale) return { label: 'Đã đổi sau khi duyệt', css: 'stale' };
  if (item.review.verdict === 'approved') return { label: 'Đạt', css: 'approved' };
  if (item.review.verdict === 'changes') return { label: 'Cần sửa', css: 'changes' };
  return { label: 'Chưa duyệt', css: 'unreviewed' };
}

function badges(item: PreviewItem, compact: boolean): HTMLElement {
  const status = reviewStatus(item);
  return h(
    'span',
    { class: 'badges' },
    item.applied
      ? h('span', { class: 'badge applied', title: `Đã có trên Taiga (id ${item.applied.id})` }, `Đã đẩy #${item.applied.ref}`)
      : h('span', { class: 'badge new' }, 'Mới'),
    h('span', { class: `badge ${status.css}` }, compact && status.css === 'stale' ? 'Đã đổi' : status.label),
    item.review.openComments > 0 &&
      h('span', { class: 'badge comments', title: 'Góp ý chưa xử lý' }, `${item.review.openComments} góp ý`),
  );
}

function matches(item: PreviewItem, filter: Filter): boolean {
  if (filter === 'unreviewed') return !item.review.verdict;
  if (filter === 'changes') return item.review.verdict === 'changes' && !item.review.stale;
  if (filter === 'stale') return item.review.stale;
  return true;
}

/** The tree in display order, epics then issues; with a filter, an item shows when it or one of its children matches. */
function visibleNodes(view: ProjectView, filter: Filter): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const epic of view.preview.epics) {
    const storyNodes: TreeNode[] = [];
    for (const story of epic.stories) {
      const tasks = story.tasks.filter((task) => matches(task, filter)).map((task) => ({ item: task, depth: 2, epic, story }));
      if (matches(story, filter) || tasks.length > 0) storyNodes.push({ item: story, depth: 1, epic, story }, ...tasks);
    }
    if (matches(epic, filter) || storyNodes.length > 0) nodes.push({ item: epic, depth: 0, epic }, ...storyNodes);
  }
  for (const issue of view.preview.issues) if (matches(issue, filter)) nodes.push({ item: issue, depth: 0 });
  return nodes;
}

function findNode(view: ProjectView, key: string | undefined): TreeNode | undefined {
  return key === undefined ? undefined : visibleNodes(view, 'all').find((node) => node.item.key === key);
}

// ---- feedback -------------------------------------------------------------------------------------------------

let toastTimer: number | undefined;

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const element = byId('toast');
  element.textContent = message;
  element.className = `toast ${kind}`;
  element.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (element.hidden = true), kind === 'error' ? 8000 : 3000);
}

function failureBlock(failure: Failure): HTMLElement {
  return h(
    'div',
    { class: 'failure' },
    h('p', { class: 'error' }, failure.message),
    failure.detail && h('pre', { class: 'detail-text' }, failure.detail),
    failure.issues !== undefined &&
      failure.issues.length > 0 &&
      h(
        'ul',
        { class: 'issues' },
        ...failure.issues.map((issue) =>
          h('li', {}, h('code', {}, `${issue.file}${issue.path ? ` › ${issue.path}` : ''}`), ` ${issue.message} `, h('span', { class: 'muted' }, `[${issue.rule}]`)),
        ),
      ),
  );
}

function showResult(title: string, ...content: HTMLElement[]): void {
  byId('result-content').replaceChildren(h('h2', {}, title), ...content);
  byId<HTMLDialogElement>('result-dialog').showModal();
}

/** Shows the outcome of a plan or a push for `slug` in the Thay đổi section. */
function showChangesResult(slug: string, title: string, ...content: HTMLElement[]): void {
  byId('changes-result').replaceChildren(
    h('h2', {}, title),
    h('p', { class: 'muted' }, `Dự án ${slug} · ${new Date().toLocaleTimeString('vi-VN')}`),
    ...content,
  );
}

// ---- rendering ------------------------------------------------------------------------------------------------

function renderRepo(): void {
  const repoPath = byId('repo-path');
  repoPath.textContent = state.repo ? state.repo.root : 'Chưa mở repo';
  repoPath.title = state.repo ? `Manifest: ${state.repo.manifestsDir}` : '';
  const select = byId<HTMLSelectElement>('project-select');
  const projects = state.repo?.projects ?? [];
  select.replaceChildren(
    h('option', { value: '' }, projects.length ? 'Chọn dự án…' : state.repo ? 'Không có dự án' : '—'),
    ...projects.map((project) =>
      h('option', { value: project.slug }, project.name ? `${project.name} (${project.slug})` : project.slug),
    ),
  );
  select.disabled = projects.length === 0;
  select.value = state.view?.slug ?? '';
}

function renderSummary(): void {
  const summary = byId('summary');
  const view = state.view;
  if (!view) {
    summary.replaceChildren();
    return;
  }
  const s = view.preview.summary;
  const cell = (label: string, value: number | string, css = '') =>
    h('div', { class: `stat ${css}` }, h('strong', {}, String(value)), h('span', {}, label));
  summary.replaceChildren(
    cell('Epic', s.epics),
    cell('Story', s.stories),
    cell('Task', s.tasks),
    cell('Issue', s.issues),
    h('div', { class: 'sep' }),
    cell('Mới', s.new, 'new'),
    cell('Đã đẩy', s.applied, 'applied'),
    h('div', { class: 'sep' }),
    cell('Đạt', s.approved, 'approved'),
    cell('Cần sửa', s.changes, 'changes'),
    cell('Chưa duyệt', s.unreviewed, 'unreviewed'),
    cell('Đã đổi sau khi duyệt', s.stale, 'stale'),
    cell('Góp ý mở', s.openComments, 'comments'),
    h('div', { class: 'spacer' }),
    view.validation.valid
      ? h('div', { class: 'validity ok' }, 'Manifest hợp lệ')
      : h(
          'button',
          {
            type: 'button',
            class: 'validity bad',
            onclick: () =>
              showResult(
                'Manifest chưa hợp lệ',
                failureBlock({ ok: false, message: view.validation.error ?? 'taigent validate báo lỗi', issues: view.validation.issues }),
              ),
          },
          `Manifest lỗi (${view.validation.issues.length || 1}) – xem`,
        ),
  );
  if (s.unknownReviewKeys.length > 0) {
    summary.append(h('div', { class: 'validity warn', title: s.unknownReviewKeys.join(', ') }, `${s.unknownReviewKeys.length} góp ý cho mục đã xoá`));
  }
}

function renderTree(): void {
  const tree = byId('tree');
  const view = state.view;
  if (!view) {
    tree.replaceChildren();
    return;
  }
  const nodes = visibleNodes(view, state.filter);
  if (nodes.length === 0) {
    tree.replaceChildren(h('div', { class: 'empty small' }, 'Không có mục nào khớp bộ lọc.'));
    return;
  }
  const firstIssue = nodes.findIndex((node) => node.item.type === 'issue');
  tree.replaceChildren(
    ...nodes.flatMap((node, index) => [
      ...(index === firstIssue ? [h('div', { class: 'tree-group' }, `Issues (${view.preview.issues.length})`)] : []),
      h(
        'button',
        {
          type: 'button',
          class: `node depth-${node.depth} ${node.item.key === state.selected ? 'selected' : ''} ${matches(node.item, state.filter) ? '' : 'context'}`,
          'data-key': node.item.key,
          onclick: () => select(node.item.key),
        },
        h('span', { class: `type type-${node.item.type}` }, TYPE_LABEL[node.item.type]),
        h('span', { class: 'subject' }, node.item.subject),
        badges(node.item, true),
      ),
    ]),
  );
  tree.querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' });
}

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('vi-VN');
}

function section(title: string, ...content: (HTMLElement | false | undefined)[]): HTMLElement {
  return h('section', { class: 'block' }, h('h3', {}, title), ...content);
}

function markdownBlock(text: string): HTMLElement {
  const element = h('div', { class: 'markdown' });
  if (text.trim()) element.append(renderMarkdown(text));
  else element.append(h('p', { class: 'muted' }, '(không có mô tả)'));
  return element;
}

function itemLink(item: PreviewItem): HTMLElement {
  return h(
    'li',
    {},
    h('button', { type: 'button', class: 'link', onclick: () => select(item.key) }, h('code', {}, item.key), ` ${item.subject}`),
    ' ',
    badges(item, true),
  );
}

function verdictBar(item: PreviewItem): HTMLElement {
  const review = item.review;
  const button = (verdict: VerdictChoice, label: string, css: string) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn verdict ${css} ${review.verdict === verdict && !review.stale ? 'on' : ''}`,
        'data-verdict': verdict,
        onclick: () => void setVerdict(item.key, verdict),
      },
      label,
    );
  const note = review.verdict
    ? h(
        'span',
        { class: `verdict-note ${review.stale ? 'stale' : ''}` },
        `${review.verdict === 'approved' ? 'Đạt' : 'Cần sửa'} – ${review.by ?? '?'}, ${formatTime(review.at)}`,
        review.stale && h('strong', {}, ' · Nội dung đã đổi sau khi duyệt, hãy xem lại.'),
      )
    : h('span', { class: 'verdict-note muted' }, 'Chưa duyệt');
  return h(
    'div',
    { class: 'verdict-bar' },
    button('approved', 'Đạt', 'approve'),
    button('changes', 'Cần sửa', 'changes'),
    review.verdict && button('clear', 'Bỏ đánh giá', 'clear'),
    note,
  );
}

function commentsBlock(item: PreviewItem): HTMLElement {
  const comments = item.review.comments;
  return section(
    `Góp ý (${comments.length}${item.review.openComments ? `, ${item.review.openComments} chưa xử lý` : ''})`,
    comments.length === 0
      ? h('p', { class: 'muted' }, 'Chưa có góp ý.')
      : h(
          'ol',
          { class: 'comments' },
          ...comments.map((comment) =>
            h(
              'li',
              { class: `comment ${comment.resolved ? 'resolved' : 'open'}` },
              h(
                'div',
                { class: 'comment-head' },
                h('strong', {}, comment.by),
                h('span', { class: 'muted' }, formatTime(comment.at)),
                h('span', { class: `badge ${comment.resolved ? 'approved' : 'changes'}` }, comment.resolved ? 'Đã xử lý' : 'Chưa xử lý'),
              ),
              h('p', { class: 'comment-text' }, comment.text),
              comment.reply && h('div', { class: 'reply' }, h('span', { class: 'reply-label' }, 'Agent trả lời'), h('p', {}, comment.reply)),
            ),
          ),
        ),
  );
}

function renderDetail(): void {
  const content = byId('detail-content');
  const composer = byId<HTMLFormElement>('composer');
  const view = state.view;
  const node = view && findNode(view, state.selected);
  if (!view || !node) {
    content.replaceChildren(
      h('div', { class: 'empty' }, view ? 'Chọn một mục trong cây bên trái.' : 'Mở thư mục repo có taiga/<slug>/backlog.yaml, rồi chọn dự án.'),
    );
    composer.hidden = true;
    return;
  }
  const item = node.item;
  const story = item.type === 'story' ? node.story : undefined;
  const epic = item.type === 'epic' ? node.epic : undefined;
  const trail = [node.epic, node.story].filter((parent): parent is PreviewEpic | PreviewStory => parent !== undefined && parent !== item);
  const attributes = Object.entries(item.customAttributes);
  const values = item.type === 'issue' ? (item as PreviewIssue).values : undefined;

  const blocks: (HTMLElement | false | undefined | '')[] = [
    h(
      'nav',
      { class: 'breadcrumb' },
      ...trail.flatMap((parent) => [h('button', { type: 'button', class: 'link', onclick: () => select(parent.key) }, parent.subject), ' › ']),
      h('span', {}, item.key),
    ),
    h(
      'header',
      { class: 'detail-head' },
      h('div', { class: 'detail-meta' }, h('span', { class: `type type-${item.type}` }, TYPE_LABEL[item.type]), h('code', {}, item.key), badges(item, false)),
      h('h1', {}, item.subject),
      verdictBar(item),
      itemActions(item),
    ),
    section('Mô tả (đúng nội dung ghi lên Taiga)', markdownBlock(item.description)),
    values &&
      section(
        'Phân loại',
        h(
          'table',
          { class: 'attributes issue-values' },
          h('tr', {}, h('th', {}, 'Loại'), h('td', {}, values.type)),
          h('tr', {}, h('th', {}, 'Mức độ'), h('td', {}, values.severity)),
          h('tr', {}, h('th', {}, 'Ưu tiên'), h('td', {}, values.priority)),
        ),
      ),
    story && section(`Task (${story.tasks.length})`, story.tasks.length ? h('ul', { class: 'children' }, ...story.tasks.map(itemLink)) : h('p', { class: 'muted' }, 'Không có task.')),
    epic && section(`Story (${epic.stories.length})`, h('ul', { class: 'children' }, ...epic.stories.map(itemLink))),
    (item.tags.length > 0 || attributes.length > 0) &&
      section(
        'Tag và thuộc tính',
        item.tags.length > 0 && h('div', { class: 'tags' }, ...item.tags.map((tag) => h('span', { class: 'tag' }, tag))),
        attributes.length > 0 &&
          h('table', { class: 'attributes' }, ...attributes.map(([name, value]) => h('tr', {}, h('th', {}, name), h('td', {}, String(value))))),
      ),
    commentsBlock(item),
  ];
  content.replaceChildren(...blocks.filter((block): block is HTMLElement => block instanceof HTMLElement));

  const textarea = byId<HTMLTextAreaElement>('comment-text');
  if (composer.dataset.key !== item.key) {
    composer.dataset.key = item.key;
    textarea.value = drafts.get(item.key) ?? '';
  }
  composer.hidden = false;
}

function renderButtons(): void {
  const hasProject = Boolean(state.view);
  byId<HTMLButtonElement>('plan-btn').disabled = !hasProject || state.busy;
  byId<HTMLButtonElement>('apply-btn').disabled = !hasProject || state.busy;
  const loginButton = byId('login-btn');
  loginButton.textContent = state.login?.loggedIn ? `${state.login.username} · Đăng xuất` : 'Đăng nhập';
  loginButton.title = state.login?.loggedIn ? `Đăng nhập ${state.login.apiUrl} (${state.login.source})` : (state.login?.message ?? '');
  byId('statusbar').textContent = [
    state.view ? `Người duyệt: ${state.view.reviewer}` : '',
    state.login ? (state.login.loggedIn ? `Taiga: ${state.login.username} @ ${state.login.apiUrl}` : (state.login.message ?? 'Chưa đăng nhập Taiga.')) : '',
    state.busy ? 'Đang chạy taigent…' : '',
  ]
    .filter(Boolean)
    .join('   ·   ');
}

/** The Thay đổi section's overview of the open project: what a push would carry and its review state. */
function renderChanges(): void {
  const overview = byId('changes-overview');
  const view = state.view;
  if (!view) {
    overview.replaceChildren(h('div', { class: 'empty-state' }, 'Mở thư mục repo và chọn dự án để xem thay đổi.'));
    return;
  }
  const s = view.preview.summary;
  overview.replaceChildren(
    h(
      'p',
      {},
      h('strong', {}, view.slug),
      ` · ${s.epics} epic, ${s.stories} story, ${s.tasks} task, ${s.issues} issue · Mới ${s.new} · Đã đẩy ${s.applied}`,
    ),
    h(
      'p',
      { class: 'muted' },
      `Đạt ${s.approved} · Cần sửa ${s.changes} · Chưa duyệt ${s.unreviewed} · Đã đổi sau khi duyệt ${s.stale} · Góp ý mở ${s.openComments} · `,
      view.validation.valid ? 'Manifest hợp lệ' : h('strong', { class: 'error' }, 'Manifest lỗi'),
    ),
  );
}

function renderVersions(versions: AppState['versions']): void {
  byId('settings-versions').replaceChildren(
    ...Object.entries({ 'Taigent Desktop': versions.app, taigent: versions.taigent, Electron: versions.electron, Node: versions.node }).map(
      ([name, value]) => h('tr', {}, h('th', {}, name), h('td', {}, value)),
    ),
  );
}

function render(): void {
  renderRepo();
  renderSummary();
  renderTree();
  renderDetail();
  renderChanges();
  renderButtons();
}

// ---- actions --------------------------------------------------------------------------------------------------

function select(key: string): void {
  state.selected = key;
  renderTree();
  renderDetail();
  byId('detail').scrollTop = 0;
}

function move(step: 1 | -1): void {
  if (!state.view) return;
  const nodes = visibleNodes(state.view, state.filter);
  if (nodes.length === 0) return;
  const index = nodes.findIndex((node) => node.item.key === state.selected);
  const next = nodes[Math.min(nodes.length - 1, Math.max(0, index === -1 ? 0 : index + step))];
  if (next) select(next.item.key);
}

/** Shows a new view of the open project, keeping the selection when the item still exists. */
function applyView(result: Result<ProjectView>): void {
  if (!result.ok) {
    showResult('Không đọc được dự án', failureBlock(result));
    return;
  }
  state.view = result.value;
  if (!findNode(result.value, state.selected)) state.selected = visibleNodes(result.value, 'all')[0]?.item.key;
  render();
}

/** Forgets the plan or push result shown in Thay đổi: it belongs to the project that was open, or to a run before. */
function clearChangesResult(note?: string): void {
  byId('changes-result').replaceChildren(...(note ? [h('p', { class: 'muted' }, note)] : []));
}

async function openProject(slug: string): Promise<void> {
  clearChangesResult();
  if (!slug) {
    state.view = undefined;
    state.selected = undefined;
    render();
    return;
  }
  state.selected = undefined;
  applyView(await api.openProject(slug));
}

async function setVerdict(key: string, verdict: VerdictChoice): Promise<void> {
  if (!state.view) return;
  const result = await api.setVerdict(state.view.slug, key, verdict);
  if (!result.ok) return void toast(result.message, 'error');
  applyView(result);
  toast(verdict === 'clear' ? `Đã bỏ đánh giá ${key}` : `${key}: ${verdict === 'approved' ? 'Đạt' : 'Cần sửa'}`);
}

async function sendComment(): Promise<void> {
  const textarea = byId<HTMLTextAreaElement>('comment-text');
  const key = byId<HTMLFormElement>('composer').dataset.key;
  const text = textarea.value.trim();
  if (!state.view || !key || !text) return;
  const result = await api.addComment(state.view.slug, key, text);
  if (!result.ok) return void toast(result.message, 'error');
  drafts.delete(key);
  textarea.value = '';
  applyView(result);
  toast(`Đã thêm góp ý cho ${key}`);
}

async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  state.busy = true;
  renderButtons();
  try {
    return await fn();
  } finally {
    state.busy = false;
    renderButtons();
  }
}

function planTable(plan: Plan): HTMLElement {
  const operations = plan.operations.filter((operation) => operation.action !== 'skip');
  const subjects = new Map(state.view ? visibleNodes(state.view, 'all').map((node) => [node.item.key, node.item.subject]) : []);
  const ACTION: Record<string, string> = { create: 'Tạo mới', update: 'Cập nhật', link: 'Gắn vào epic' };
  return h(
    'div',
    {},
    h(
      'p',
      {},
      `Tạo mới ${plan.summary.create} · Cập nhật ${plan.summary.update} · Gắn epic ${plan.summary.link} · Không đổi ${plan.summary.skip}`,
    ),
    operations.length > 0 &&
      h(
        'table',
        { class: 'plan' },
        h('tr', {}, h('th', {}, 'Thao tác'), h('th', {}, 'Loại'), h('th', {}, 'Mục'), h('th', {}, 'Chi tiết')),
        ...operations.map((operation) =>
          h(
            'tr',
            { class: `op-${operation.action}` },
            h('td', {}, ACTION[operation.action] ?? operation.action),
            h('td', {}, TYPE_LABEL[operation.type as PreviewItem['type']] ?? operation.type),
            h('td', {}, h('code', {}, operation.key), ` ${operation.fields?.subject ?? subjects.get(operation.key) ?? ''}`),
            h(
              'td',
              { class: 'muted' },
              operation.action === 'update'
                ? `Đổi: ${Object.keys(operation.changes ?? {}).join(', ')}${operation.ref ? ` (#${operation.ref})` : ''}`
                : operation.action === 'link'
                  ? `→ ${operation.epic}`
                  : operation.parent
                    ? `thuộc ${operation.parent}`
                    : '',
            ),
          ),
        ),
      ),
    plan.orphans.length > 0 &&
      h(
        'div',
        { class: 'warn-box' },
        h('strong', {}, `${plan.orphans.length} mục trên Taiga không còn trong backlog (taigent không xoá):`),
        h(
          'ul',
          {},
          ...plan.orphans.map((orphan) => h('li', {}, `${TYPE_LABEL[orphan.type as PreviewItem['type']] ?? orphan.type} #${orphan.ref} ${orphan.key} – ${orphan.subject}`)),
        ),
      ),
  );
}

async function showPlan(): Promise<void> {
  if (!state.view) return;
  const slug = state.view.slug;
  clearChangesResult('Đang chạy taigent plan…');
  const result = await withBusy(() => api.plan(slug));
  if (!result.ok) return showChangesResult(slug, 'Xem thay đổi trên Taiga', failureBlock(result));
  showChangesResult(
    slug,
    result.value.changes ? 'Thay đổi sẽ ghi lên Taiga' : 'Taiga đã khớp với backlog',
    result.value.changes ? planTable(result.value) : h('p', {}, 'Không có thay đổi nào cần đẩy.'),
  );
}

function applyOutcome(slug: string, outcome: ApplyOutcome): void {
  if (outcome.status === 'cancelled') {
    toast('Đã huỷ, chưa ghi gì lên Taiga.');
    return showChangesResult(slug, 'Đã huỷ đẩy lên Taiga', h('p', {}, 'Chưa ghi gì lên Taiga.'));
  }
  if (outcome.status === 'blocked') {
    return showChangesResult(
      slug,
      'Chưa thể đẩy lên Taiga',
      h('ul', { class: 'issues' }, ...outcome.reasons.map((reason) => h('li', {}, reason))),
      h('p', { class: 'muted' }, 'Nhờ agent xử lý góp ý (skill taiga-plan-backlog), rồi duyệt lại trong mục Backlog.'),
    );
  }
  if (outcome.status === 'no-changes') return showChangesResult(slug, 'Taiga đã khớp với backlog', h('p', {}, 'Không có thay đổi nào cần đẩy.'));
  const { report } = outcome;
  const RESULT: Record<string, string> = { created: 'Đã tạo', updated: 'Đã cập nhật', linked: 'Đã gắn', unchanged: 'Không đổi' };
  showChangesResult(
    slug,
    'Đã đẩy lên Taiga',
    h(
      'p',
      {},
      `Tạo ${report.summary.created} · Cập nhật ${report.summary.updated} · Gắn epic ${report.summary.linked} · Không đổi ${report.summary.unchanged}`,
    ),
    h(
      'table',
      { class: 'plan' },
      h('tr', {}, h('th', {}, 'Kết quả'), h('th', {}, 'Loại'), h('th', {}, 'Mục'), h('th', {}, 'Ref')),
      ...report.operations
        .filter((operation) => operation.result !== 'unchanged')
        .map((operation) =>
          h(
            'tr',
            {},
            h('td', {}, RESULT[operation.result] ?? operation.result),
            h('td', {}, TYPE_LABEL[operation.type as PreviewItem['type']] ?? operation.type),
            h('td', {}, h('code', {}, operation.key)),
            h('td', {}, `#${operation.ref}`),
          ),
        ),
    ),
  );
}

async function pushToTaiga(): Promise<void> {
  if (!state.view) return;
  const slug = state.view.slug;
  clearChangesResult('Đang kiểm tra trước khi đẩy…');
  const result = await withBusy(() => api.apply(slug));
  if (!result.ok) return showChangesResult(slug, 'Đẩy lên Taiga', failureBlock(result));
  applyOutcome(slug, result.value);
}

async function refreshLogin(): Promise<void> {
  state.login = await api.whoami();
  renderButtons();
}

async function onLoginButton(): Promise<void> {
  if (state.login?.loggedIn) {
    if (!window.confirm(`Đăng xuất ${state.login.username} khỏi ${state.login.apiUrl}?`)) return;
    const result = await api.logout();
    if (!result.ok) toast(result.message, 'error');
    else toast('Đã đăng xuất.');
    await refreshLogin();
    return;
  }
  byId('login-error').hidden = true;
  byId<HTMLInputElement>('login-password').value = '';
  if (state.login?.apiUrl) byId<HTMLInputElement>('login-url').value = state.login.apiUrl;
  byId<HTMLDialogElement>('login-dialog').showModal();
}

async function submitLogin(event: Event): Promise<void> {
  event.preventDefault();
  const password = byId<HTMLInputElement>('login-password');
  const submit = byId<HTMLButtonElement>('login-submit');
  submit.disabled = true;
  const result = await api.login({
    apiUrl: byId<HTMLInputElement>('login-url').value,
    username: byId<HTMLInputElement>('login-user').value,
    password: password.value,
  });
  password.value = '';
  submit.disabled = false;
  if (!result.ok) {
    const error = byId('login-error');
    error.textContent = result.detail ? `${result.message} (${result.detail})` : result.message;
    error.hidden = false;
    return;
  }
  byId<HTMLDialogElement>('login-dialog').close();
  toast(`Đã đăng nhập: ${result.value.username}`);
  await refreshLogin();
  if (state.view) applyView(await api.openProject(state.view.slug));
}

function useRepo(result: Result<RepoInfo> | undefined): void {
  if (!result) return;
  if (!result.ok) return showResult('Không mở được thư mục', failureBlock(result));
  state.repo = result.value;
  state.view = undefined;
  state.selected = undefined;
  clearChangesResult();
  render();
  gitRepoChanged();
  const only = result.value.projects.length === 1 ? result.value.projects[0] : undefined;
  if (only) void openProject(only.slug);
}

// ---- wiring ---------------------------------------------------------------------------------------------------

function wire(): void {
  wireNavigation();
  wireTerminal(api.terminal, (message) => toast(message, 'error'));
  onSectionChange((section) => {
    // A hidden tree cannot scroll: bring the selected item back into view when Backlog shows again.
    if (section === 'backlog') byId('tree').querySelector('.node.selected')?.scrollIntoView({ block: 'nearest' });
  });
  byId('open-repo').addEventListener('click', async () => useRepo(await api.openRepo()));
  byId<HTMLSelectElement>('project-select').addEventListener('change', (event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLSelectElement) void openProject(target.value);
  });
  byId('plan-btn').addEventListener('click', () => void showPlan());
  byId('apply-btn').addEventListener('click', () => void pushToTaiga());
  byId('login-btn').addEventListener('click', () => void onLoginButton());
  byId('login-form').addEventListener('submit', (event) => void submitLogin(event));
  byId('login-cancel').addEventListener('click', () => byId<HTMLDialogElement>('login-dialog').close());
  byId('result-close').addEventListener('click', () => byId<HTMLDialogElement>('result-dialog').close());
  for (const button of document.querySelectorAll<HTMLButtonElement>('.filter')) {
    button.addEventListener('click', () => {
      state.filter = (button.dataset.filter ?? 'all') as Filter;
      for (const other of document.querySelectorAll('.filter')) other.classList.toggle('active', other === button);
      renderTree();
    });
  }
  const composer = byId<HTMLFormElement>('composer');
  const textarea = byId<HTMLTextAreaElement>('comment-text');
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    void sendComment();
  });
  textarea.addEventListener('input', () => {
    if (composer.dataset.key) drafts.set(composer.dataset.key, textarea.value);
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendComment();
    }
  });
  document.addEventListener('click', (event) => {
    const link = event.target instanceof Element ? event.target.closest('a[data-external]') : null;
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('data-external');
    if (href) void api.openExternal(href);
  });
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (document.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (currentSection() !== 'backlog') return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    }
  });
  api.onProjectChanged((result) => {
    if (result.ok && result.value.slug !== state.view?.slug) return;
    applyView(result);
  });
  mountForms({
    api,
    view: () => state.view,
    showView(result, key) {
      if (key !== undefined) state.selected = key;
      applyView(result);
    },
    toast,
    failureBlock,
  });
  mountTaigaProjects({
    api,
    repoRoot: () => state.repo?.root,
    async openBacklog(slug) {
      // A project.yaml or backlog.yaml written since the repository was read: list it in the picker first.
      const repo = await api.refreshRepo();
      if (repo.ok) state.repo = repo.value;
      await openProject(slug);
      showSection('backlog');
    },
    toast,
    failureBlock,
  });
  wireGit({ api, failureBlock, toast, hasRepo: () => Boolean(state.repo) });
  mountMyTickets({ api, loginKey: () => `${state.login?.loggedIn}:${state.login?.apiUrl}:${state.login?.username}`, toast, failureBlock });
}

async function start(): Promise<void> {
  wire();
  const initial = await api.getState();
  state.repo = initial.repo;
  document.title = `Taigent Desktop ${initial.versions.app}`;
  renderVersions(initial.versions);
  render();
  if (initial.repo?.projects.length === 1 && initial.repo.projects[0]) await openProject(initial.repo.projects[0].slug);
  await refreshLogin();
}

void start();

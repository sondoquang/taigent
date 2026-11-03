// Taiga > Project: the user's Taiga projects and the repository's manifest directories, one project's detail (its
// issue values on Taiga), the project.yaml form and bootstrap. Reads go through `taigent projects`; the form writes
// project.yaml only (taigent's project-settings API); Taiga is written only by `bootstrap --yes`, after the main
// process's native confirmation.

import { PROJECT_MODULES, PROJECT_TEMPLATES, projectSlug, REQUIRED_MODULES } from '../../../src/manifest/conventions.ts';
import type {
  BootstrapOutcome,
  Failure,
  ManifestIssue,
  ProjectSettings,
  TaigaProjectDetail,
  TaigaProjectRow,
  TaigaProjectsOverview,
  TaigentApi,
} from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { onSectionChange } from './navigation.ts';

export interface TaigaProjectsContext {
  api: TaigentApi;
  /** The opened repository, or undefined. */
  repoRoot(): string | undefined;
  /** Opens the project's backlog in the Backlog section. */
  openBacklog(slug: string): Promise<void>;
  toast(message: string, kind?: 'info' | 'error'): void;
  failureBlock(failure: Failure): HTMLElement;
}

/** The form being edited: a project directory (`slug`), or a new project whose slug comes from the name. */
interface FormState {
  slug: string | undefined;
  baseDigest: string | null;
  settings: ProjectSettings;
  issues: ManifestIssue[];
  dirty: boolean;
  /** Set when a save found project.yaml changed since the form read it. */
  conflict: boolean;
}

const NEW_PROJECT: ProjectSettings = { name: '', description: '', template: 'scrum', isPrivate: true, modules: ['epics', 'backlog', 'wiki'], existing: false };

let context: TaigaProjectsContext;
let overview: TaigaProjectsOverview | undefined;
let loadedFor: string | undefined;
let detail: TaigaProjectDetail | undefined;
let form: FormState | undefined;
let busy = false;
const listedListeners: ((overview: TaigaProjectsOverview) => void)[] = [];

function setBusy(on: boolean): void {
  busy = on;
  for (const button of byId('taiga-project').querySelectorAll<HTMLButtonElement>('button')) button.disabled = on || button.dataset.off === 'true';
}

function rowState(row: TaigaProjectRow): string {
  if (row.hasBacklog) return 'Có backlog.yaml';
  if (row.hasProjectYaml) return 'Có project.yaml';
  return row.manifest ? 'Có thư mục, chưa có project.yaml' : 'Chưa có manifest';
}

function renderList(): void {
  const status = byId('taiga-projects-status');
  const list = byId('taiga-projects-list');
  if (!context.repoRoot()) {
    status.textContent = 'Mở một thư mục repo để xem project.';
    list.replaceChildren();
    return;
  }
  if (!overview) {
    status.textContent = 'Đang đọc project…';
    list.replaceChildren();
    return;
  }
  status.textContent = overview.taigaMessage ?? `${overview.rows.filter((row) => row.taiga).length} project trên Taiga mà bạn là thành viên.`;
  if (overview.rows.length === 0) {
    list.replaceChildren(h('p', { class: 'muted' }, 'Chưa có project nào. Bấm “Tạo project mới…” để viết project.yaml.'));
    return;
  }
  list.replaceChildren(
    h(
      'table',
      { class: 'taiga-projects-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Project'), h('th', {}, 'Slug'), h('th', {}, 'Taiga'), h('th', {}, 'Trong repo'), h('th', {}))),
      h(
        'tbody',
        {},
        ...overview.rows.map((row) =>
          h(
            'tr',
            { 'data-slug': row.slug, class: row.slug === (form?.slug ?? detail?.slug) ? 'selected' : '' },
            h('td', {}, row.name ?? '—'),
            h('td', {}, h('code', {}, row.slug)),
            h('td', {}, row.taiga ? `#${row.taiga.id} · ${row.taiga.admin ? 'admin' : 'thành viên'}` : 'Chưa có trên Taiga'),
            h('td', {}, rowState(row)),
            h(
              'td',
              {},
              h(
                'button',
                { type: 'button', class: 'btn', 'data-open': row.slug, onclick: () => void openDetail(row.slug) },
                row.hasProjectYaml ? 'Mở' : 'Tạo project.yaml',
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function issueList(issues: ManifestIssue[]): HTMLElement | false {
  return (
    issues.length > 0 &&
    h(
      'ul',
      { class: 'issues', id: 'pf-issues' },
      ...issues.map((issue) => h('li', {}, h('code', {}, issue.path || '(file)'), ` ${issue.message} `, h('span', { class: 'muted' }, `[${issue.rule}]`))),
    )
  );
}

function taigaBlock(): HTMLElement | false {
  if (!detail) return false;
  const taiga = detail.taiga;
  if (!taiga) return h('p', { class: 'muted', id: 'taiga-project-remote' }, detail.taigaMessage ?? '');
  const values = (label: string, names: string[]) => h('tr', {}, h('th', {}, label), h('td', {}, names.length ? names.join(', ') : '(không có)'));
  return h(
    'div',
    { id: 'taiga-project-remote' },
    h('p', {}, `Trên Taiga: #${taiga.project.id} ${taiga.project.name} · bạn là ${taiga.project.admin ? 'admin' : 'thành viên (bootstrap cần quyền admin)'}`),
    h('table', { class: 'taiga-values' }, values('Issue type', taiga.issueTypes), values('Severity', taiga.severities), values('Priority', taiga.priorities)),
  );
}

function readForm(): ProjectSettings {
  return {
    name: byId<HTMLInputElement>('pf-name').value.trim(),
    description: byId<HTMLTextAreaElement>('pf-description').value,
    template: byId<HTMLSelectElement>('pf-template').value,
    isPrivate: byId<HTMLInputElement>('pf-private').checked,
    modules: [...document.querySelectorAll<HTMLInputElement>('#project-form input[name="pf-module"]:checked')].map((input) => input.value),
    // Not a form control: set when the name was taken from the project on Taiga (formFor), kept from the file otherwise.
    existing: form?.settings.existing ?? false,
  };
}

function slugHint(): string {
  if (!form) return '';
  if (form.slug !== undefined) return form.slug;
  const name = byId<HTMLInputElement>('pf-name').value.trim();
  return name ? projectSlug(name) || '(tên chưa cho ra slug)' : '(theo tên project)';
}

function projectForm(state: FormState): HTMLElement {
  const { settings } = state;
  const onInput = () => {
    state.dirty = true;
    byId('pf-slug').textContent = slugHint();
    renderBootstrapButton();
  };
  const conflict =
    state.conflict &&
    h(
      'div',
      { class: 'failure', id: 'pf-conflict' },
      h('p', { class: 'error' }, 'project.yaml đã đổi từ lúc bạn mở form (có thể agent vừa sửa). Chưa ghi gì.'),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => void reloadForm() }, 'Bỏ thay đổi của tôi, tải lại file'),
        h('button', { type: 'button', class: 'btn', onclick: () => void saveForm(true) }, 'Ghi phần của tôi lên bản mới'),
      ),
    );
  return h(
    'form',
    {
      id: 'project-form',
      class: 'project-form',
      onsubmit: (event: Event) => {
        event.preventDefault();
        void saveForm(false);
      },
      oninput: onInput,
    },
    h('h3', {}, state.baseDigest === null ? 'Tạo project.yaml' : 'project.yaml'),
    h('label', {}, 'Tên project (', h('code', {}, '<Khách hàng/Mảng> - <Sản phẩm>'), ') ', h('input', { id: 'pf-name', type: 'text', required: true, value: settings.name, placeholder: 'Vigo - Core Mapping' })),
    h('p', { class: 'muted' }, 'Slug: ', h('code', { id: 'pf-slug' }, '')),
    h('label', {}, 'Mô tả ', h('textarea', { id: 'pf-description', rows: '3' }, settings.description)),
    h(
      'label',
      {},
      'Template ',
      h('select', { id: 'pf-template' }, ...PROJECT_TEMPLATES.map((template) => h('option', { value: template, selected: template === settings.template }, template))),
    ),
    h('label', { class: 'inline' }, h('input', { id: 'pf-private', type: 'checkbox', checked: settings.isPrivate }), ' Project riêng tư'),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Module bật'),
      ...PROJECT_MODULES.map((module) =>
        h(
          'label',
          { class: 'inline' },
          h('input', { type: 'checkbox', name: 'pf-module', value: module, checked: settings.modules.includes(module) }),
          ` ${module}${REQUIRED_MODULES.includes(module) ? ' (bắt buộc)' : ''}`,
        ),
      ),
    ),
    issueList(state.issues),
    conflict,
    h(
      'p',
      { class: 'muted' },
      'Form chỉ sửa các trường trên; tag, custom attribute, member và wiki_home trong project.yaml được giữ nguyên.',
    ),
    h('div', { class: 'modal-actions' }, h('button', { type: 'submit', class: 'btn primary', id: 'pf-save' }, 'Lưu project.yaml')),
  );
}

function renderBootstrapButton(): void {
  const button = document.getElementById('taiga-bootstrap');
  if (!(button instanceof HTMLButtonElement)) return;
  const off = !detail || detail.file.digest === null || Boolean(form?.dirty);
  button.dataset.off = String(off);
  button.disabled = busy || off;
  button.title = off ? 'Lưu project.yaml trước khi bootstrap.' : '';
}

function renderDetail(): void {
  const container = byId('taiga-project-detail');
  if (!form) {
    container.replaceChildren();
    return;
  }
  const title = detail ? (detail.taiga?.project.name ?? form.settings.name) || detail.slug : 'Project mới';
  container.replaceChildren(
    h(
      'div',
      { class: 'taiga-project-card' },
      h('h2', {}, title, detail && h('code', { class: 'slug' }, detail.slug)),
      taigaBlock(),
      detail?.hasBacklog && h('button', { type: 'button', class: 'btn', id: 'taiga-open-backlog', onclick: () => void context.openBacklog(detail!.slug) }, 'Mở backlog'),
      projectForm(form),
      detail &&
        h(
          'div',
          { class: 'bootstrap-block' },
          h('h3', {}, 'Bootstrap'),
          h(
            'p',
            { class: 'muted' },
            'Tạo project trên Taiga theo project.yaml, hoặc bổ sung phần còn thiếu (module, tag, custom attribute, member, wiki home). ' +
              'Ứng dụng chạy bootstrap --dry-run, hỏi xác nhận, rồi mới chạy --yes. Không bao giờ tắt, đổi tên hay xoá gì.',
          ),
          h('button', { type: 'button', class: 'btn primary', id: 'taiga-bootstrap', onclick: () => void runBootstrap() }, 'Bootstrap lên Taiga…'),
          h('div', { id: 'taiga-bootstrap-result', 'aria-live': 'polite' }),
        ),
    ),
  );
  byId('pf-slug').textContent = slugHint();
  renderBootstrapButton();
}

function formFor(found: TaigaProjectDetail): FormState {
  // The name comes from a project already on Taiga, which may not follow `<A> - <B>`: mark it `existing: true`.
  const fromTaiga = found.taiga ? { ...NEW_PROJECT, name: found.taiga.project.name, existing: true } : NEW_PROJECT;
  return { slug: found.slug, baseDigest: found.file.digest, settings: found.file.settings ?? fromTaiga, issues: found.file.issues, dirty: false, conflict: false };
}

async function openDetail(slug: string): Promise<void> {
  setBusy(true);
  const result = await context.api.readTaigaProject(slug).finally(() => setBusy(false));
  if (!result.ok) return void byId('taiga-project-detail').replaceChildren(context.failureBlock(result));
  detail = result.value;
  form = formFor(detail);
  renderList();
  renderDetail();
  byId('taiga-project-detail').scrollIntoView({ block: 'start' });
}

function newProject(): void {
  detail = undefined;
  form = { slug: undefined, baseDigest: null, settings: NEW_PROJECT, issues: [], dirty: false, conflict: false };
  renderList();
  renderDetail();
  byId('taiga-project-detail').scrollIntoView({ block: 'start' });
  byId<HTMLInputElement>('pf-name').focus();
}

/** Re-reads project.yaml into the form, dropping unsaved edits. */
async function reloadForm(): Promise<void> {
  if (form?.slug === undefined) return newProject();
  await openDetail(form.slug);
}

/** Saves the form; `rebase` writes it over the current file after a conflict. */
async function saveForm(rebase: boolean): Promise<void> {
  if (!form) return;
  const settings = readForm();
  let baseDigest = form.baseDigest;
  if (rebase) {
    const slug = form.slug ?? projectSlug(settings.name);
    const current = await context.api.readTaigaProject(slug);
    if (!current.ok) return void context.toast(current.message, 'error');
    baseDigest = current.value.file.digest;
  }
  setBusy(true);
  const result = await context.api
    .saveProjectSettings({ ...(form.slug !== undefined && { slug: form.slug }), settings, baseDigest })
    .finally(() => setBusy(false));
  form.settings = settings;
  if (!result.ok) return void context.toast(result.message, 'error');
  const outcome = result.value;
  if (outcome.status === 'conflict') {
    form.conflict = true;
    return renderDetail();
  }
  if (outcome.status === 'invalid') {
    form.issues = outcome.issues;
    form.conflict = false;
    return renderDetail();
  }
  context.toast(`Đã lưu ${outcome.slug}/project.yaml.`);
  await loadList();
  await openDetail(outcome.slug);
}

function bootstrapResult(outcome: BootstrapOutcome): HTMLElement {
  if (outcome.status === 'no-changes') return h('p', {}, 'Project trên Taiga đã khớp project.yaml: không có gì để làm.');
  if (outcome.status === 'cancelled') return h('p', {}, 'Đã huỷ bootstrap, chưa ghi gì lên Taiga.');
  const { project, summary } = outcome.report;
  return h('p', {}, `Đã bootstrap project #${project.id} (${project.slug}): tạo ${summary.created}, cập nhật ${summary.updated}, giữ nguyên ${summary.unchanged}.`);
}

async function runBootstrap(): Promise<void> {
  if (!detail) return;
  const slug = detail.slug;
  byId('taiga-bootstrap-result').replaceChildren(h('p', { class: 'muted' }, 'Đang chạy taigent bootstrap --dry-run…'));
  setBusy(true);
  const result = await context.api.bootstrapProject(slug).finally(() => setBusy(false));
  renderBootstrapButton();
  if (!result.ok) return void byId('taiga-bootstrap-result').replaceChildren(context.failureBlock(result));
  const outcome = result.value;
  if (outcome.status === 'cancelled') context.toast('Đã huỷ, chưa ghi gì lên Taiga.');
  if (outcome.status === 'bootstrapped') {
    context.toast('Đã bootstrap project trên Taiga.');
    // The project (now) on Taiga: its list row and its issue values.
    await loadList();
    await openDetail(slug);
  }
  byId('taiga-bootstrap-result').replaceChildren(bootstrapResult(outcome));
}

async function loadList(): Promise<void> {
  const root = context.repoRoot();
  loadedFor = root;
  overview = undefined;
  renderList();
  if (!root) return;
  setBusy(true);
  const result = await context.api.listTaigaProjects().finally(() => setBusy(false));
  if (loadedFor !== root) return;
  if (!result.ok) {
    byId('taiga-projects-status').textContent = '';
    return void byId('taiga-projects-list').replaceChildren(context.failureBlock(result));
  }
  overview = result.value;
  renderList();
  for (const listener of listedListeners) listener(overview);
}

/** Runs `listener` each time the list is read, e.g. for Taiga > Báo cáo's project choice. */
export function onTaigaProjectsListed(listener: (overview: TaigaProjectsOverview) => void): void {
  listedListeners.push(listener);
}

/** Wires Taiga > Project; the list loads when the section shows for a repository it has not listed yet. */
export function mountTaigaProjects(ctx: TaigaProjectsContext): void {
  context = ctx;
  byId('taiga-projects-refresh').addEventListener('click', () => void loadList());
  byId('taiga-project-new').addEventListener('click', () => newProject());
  onSectionChange((section) => {
    if (section !== 'taiga' || context.repoRoot() === loadedFor) return;
    detail = undefined;
    form = undefined;
    renderDetail();
    void loadList();
  });
}

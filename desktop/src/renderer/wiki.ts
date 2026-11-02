// The Wiki section: the pages of docs.yaml, the page form (slug + Markdown with a live preview, through the manifest
// edit API via `window.taigent`) and "Đẩy wiki lên Taiga" (dry run, native confirm dialog in main, then upload).
// Wiki pages are not reviewed: no verdicts, no review.yaml.

import type {
  Failure,
  ManifestFile,
  ManifestIssue,
  ProjectView,
  SaveWikiPageRequest,
  TaigentApi,
  UploadOperation,
  UploadPlan,
  WikiPageFile,
  WikiSnapshot,
  WikiUploadOutcome,
} from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { showConflict } from './forms.ts';
import { renderMarkdown } from './markdown.ts';
import { currentSection, onSectionChange } from './navigation.ts';

/** What the Wiki section needs from the main renderer. */
export interface WikiHost {
  api: TaigentApi;
  view(): ProjectView | undefined;
  toast(message: string, kind?: 'info' | 'error'): void;
  failureBlock(failure: Failure): HTMLElement;
}

interface OpenPage {
  slug: string;
  /** The page being edited; absent for a new page. */
  page?: WikiPageFile;
  /** docs.yaml as the form opened it: its digest guards the save. */
  docs: ManifestFile;
}

let host: WikiHost | undefined;
/** docs.yaml and its pages for project `slug`, as last read. */
let loaded: { slug: string; wiki: WikiSnapshot } | undefined;
let form: OpenPage | undefined;
let busy = false;

function requireHost(): WikiHost {
  if (!host) throw new Error('wiki is not mounted');
  return host;
}

/** Creates the page form and wires the section's buttons; the list follows the open project and live changes. */
export function mountWiki(wikiHost: WikiHost): void {
  host = wikiHost;
  document.body.append(h('dialog', { id: 'wiki-form', class: 'modal wide item-form wiki-form' }, h('form', { id: 'wiki-form-body', method: 'dialog' })));
  byId<HTMLDialogElement>('wiki-form').addEventListener('close', () => (form = undefined));
  byId('wiki-add').addEventListener('click', () => void openPage());
  byId('wiki-upload').addEventListener('click', () => void upload());
  onSectionChange((section) => {
    if (section === 'wiki') void load();
  });
  wikiHost.api.onProjectChanged(() => {
    if (currentSection() === 'wiki') void load();
    void noticeChange();
  });
}

/** Called on every render of the main renderer: follows the open project. */
export function refreshWiki(): void {
  const view = requireHost().view();
  renderButtons();
  if (view?.slug === loaded?.slug) return;
  loaded = undefined;
  byId('wiki-result').replaceChildren();
  renderList();
  if (view && currentSection() === 'wiki') void load();
}

function renderButtons(): void {
  const view = requireHost().view();
  byId<HTMLButtonElement>('wiki-add').disabled = !view || busy;
  byId<HTMLButtonElement>('wiki-upload').disabled = !view || busy;
}

async function load(): Promise<void> {
  const { api, view, toast } = requireHost();
  const slug = view()?.slug;
  if (!slug) return renderList();
  const result = await api.readWiki(slug);
  if (view()?.slug !== slug) return;
  if (!result.ok) {
    loaded = undefined;
    byId('wiki-pages').replaceChildren(requireHost().failureBlock(result));
    return void toast(result.message, 'error');
  }
  loaded = { slug, wiki: result.value };
  renderList();
}

function renderList(): void {
  const list = byId('wiki-pages');
  if (!requireHost().view()) return list.replaceChildren(h('div', { class: 'empty-state' }, 'Mở thư mục repo và chọn dự án để xem wiki.'));
  if (!loaded) return list.replaceChildren();
  if (loaded.wiki.pages.length === 0) {
    return list.replaceChildren(h('div', { class: 'empty-state' }, 'Chưa có trang wiki nào trong docs.yaml. Bấm "+ Trang wiki" để tạo trang đầu tiên.'));
  }
  list.replaceChildren(
    ...loaded.wiki.pages.map((page) => {
      const title = /^#\s+(.+)$/m.exec(page.page.text)?.[1]?.trim();
      return h(
        'div',
        { class: 'wiki-page', 'data-slug': page.slug },
        h('div', { class: 'wiki-page-main' }, h('strong', {}, page.slug), title && h('span', {}, ` · ${title}`), h('div', { class: 'muted' }, h('code', {}, page.file), page.page.text === '' ? ' (trống hoặc chưa có file)' : '')),
        h('button', { type: 'button', class: 'btn small', 'data-action': 'edit', onclick: () => void openPage(page.slug) }, 'Sửa'),
      );
    }),
  );
}

// ---- page form ------------------------------------------------------------------------------------------------

/** Opens the form on page `pageSlug` (read again, for fresh digests), or on a new page. */
async function openPage(pageSlug?: string): Promise<void> {
  const { api, view, toast } = requireHost();
  const slug = view()?.slug;
  if (!slug) return void toast('Chọn dự án trước.', 'error');
  const result = await api.readWiki(slug);
  if (!result.ok) return void toast(result.message, 'error');
  loaded = { slug, wiki: result.value };
  renderList();
  const page = pageSlug === undefined ? undefined : result.value.pages.find((candidate) => candidate.slug === pageSlug);
  if (pageSlug !== undefined && !page) return void toast(`Không còn trang ${pageSlug} trong docs.yaml (agent vừa đổi?).`, 'error');
  form = { slug, docs: result.value.docs, ...(page && { page }) };

  const slugInput = h('input', { id: 'wiki-slug', type: 'text', autocomplete: 'off', spellcheck: 'false', disabled: page !== undefined, placeholder: 'spec-auth-login' });
  slugInput.value = page?.slug ?? '';
  const slugHint = h(
    'p',
    { class: 'hint' },
    page
      ? `File: ${page.file}. Slug không đổi được: trang có thể đã có trên Taiga, đổi slug sẽ tạo trang mới.`
      : 'Chữ thường, số và dấu gạch ngang, ví dụ spec-auth-login. Trang được lưu ở pages/<slug>.md.',
  );
  const content = h('textarea', { id: 'wiki-content', rows: '18', spellcheck: 'false' });
  content.value = page?.page.text.replace(/\r\n/g, '\n') ?? '';
  const preview = h('div', { class: 'markdown wiki-preview', id: 'wiki-preview' });
  const refreshPreview = () => preview.replaceChildren(renderMarkdown(content.value));
  content.addEventListener('input', refreshPreview);
  refreshPreview();

  const body = byId<HTMLFormElement>('wiki-form-body');
  body.replaceChildren(
    h(
      'div',
      { class: 'form-fields' },
      h('h2', {}, page ? `Sửa trang wiki ${page.slug}` : 'Thêm trang wiki'),
      h('p', { class: 'warn-box', id: 'wiki-stale', hidden: true }, 'docs.yaml hoặc file của trang vừa đổi từ lúc mở form (có thể do agent). Khi lưu, bạn sẽ được xem thay đổi đó rồi áp lại phần của mình.'),
      h('div', { class: 'field', 'data-field': 'slug' }, h('label', { class: 'field-label', for: 'wiki-slug' }, 'Slug'), slugInput, slugHint, h('p', { class: 'field-error', hidden: true })),
      h(
        'div',
        { class: 'field', 'data-field': 'content' },
        h('label', { class: 'field-label', for: 'wiki-content' }, 'Nội dung (Markdown)'),
        h('div', { class: 'wiki-editor' }, content, preview),
        h('p', { class: 'field-error', hidden: true }),
      ),
      h('ul', { class: 'issues', id: 'wiki-issues', hidden: true }),
      h('p', { class: 'hint' }, 'Wiki không qua review. Lưu xong, dùng "Đẩy wiki lên Taiga" để ghi lên Taiga.'),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', id: 'wiki-cancel', onclick: () => byId<HTMLDialogElement>('wiki-form').close() }, 'Huỷ'),
        h('button', { type: 'submit', class: 'btn primary', id: 'wiki-save' }, 'Lưu trang'),
      ),
    ),
  );
  body.onsubmit = (event) => {
    event.preventDefault();
    const open = form;
    if (!open) return;
    const request: SaveWikiPageRequest = {
      baseDigest: open.docs.digest,
      ...(open.page && { pageDigest: open.page.page.digest }),
      page: { slug: slugInput.value.trim(), content: content.value },
    };
    void save(open, request);
  };
  byId<HTMLDialogElement>('wiki-form').showModal();
  (page ? content : slugInput).focus();
}

/** When docs.yaml or the open page's file changes under the form (an agent edited it), the form says so. */
async function noticeChange(): Promise<void> {
  const open = form;
  if (!open) return;
  const latest = await requireHost().api.readWiki(open.slug);
  if (form !== open || !latest.ok) return;
  const page = open.page && latest.value.pages.find((candidate) => candidate.slug === open.page!.slug);
  byId('wiki-stale').hidden = latest.value.docs.digest === open.docs.digest && (!open.page || page?.page.digest === open.page.page.digest);
}

/** Puts slug issues (`wiki[1].slug`) next to the slug field; the others go to the list under the form. */
function showIssues(issues: ManifestIssue[], extra?: HTMLElement): void {
  const slugError = document.querySelector<HTMLElement>('#wiki-form .field[data-field="slug"] .field-error')!;
  const onSlug = issues.filter((issue) => /^wiki\[\d+\]\.slug$/.test(issue.path));
  slugError.textContent = onSlug.map((issue) => `${issue.message} [${issue.rule}]`).join(' ');
  slugError.hidden = onSlug.length === 0;
  const general = issues.filter((issue) => !onSlug.includes(issue));
  const list = byId('wiki-issues');
  list.replaceChildren(
    ...general.map((issue) => h('li', {}, issue.path && h('code', {}, issue.path), ` ${issue.message} `, h('span', { class: 'muted' }, `[${issue.rule}]`))),
    ...(extra ? [h('li', {}, extra)] : []),
  );
  list.hidden = general.length === 0 && !extra;
}

/** Sends one save; a conflict opens the conflict dialog, whose "Áp lại" sends it again on the current file. */
async function save(open: OpenPage, request: SaveWikiPageRequest): Promise<void> {
  const { api, toast, failureBlock } = requireHost();
  const button = byId<HTMLButtonElement>('wiki-save');
  button.disabled = true;
  const result = await api.saveWikiPage(open.slug, request).finally(() => (button.disabled = false));
  if (!result.ok) return showIssues([], failureBlock(result));
  const outcome = result.value;
  if (outcome.status === 'invalid') return showIssues(outcome.issues);
  if (outcome.status === 'conflict') {
    const { current } = outcome;
    if (current.file === open.docs.file) {
      return showConflict(
        open.docs,
        current,
        () => {
          open.docs = current;
          byId('wiki-stale').hidden = true;
          void save(open, { ...request, baseDigest: current.digest });
        },
        'docs.yaml',
      );
    }
    if (!open.page) {
      // A new page whose file already exists without a docs.yaml entry: never written over.
      return showIssues([], h('span', {}, `File ${current.file} đã có sẵn nhưng không có trong docs.yaml. Chọn slug khác, hoặc nhờ agent thêm entry cho file đó.`));
    }
    const page = open.page;
    return showConflict(
      page.page,
      current,
      () => {
        page.page = current;
        byId('wiki-stale').hidden = true;
        void save(open, { ...request, pageDigest: current.digest });
      },
      page.file,
    );
  }
  byId<HTMLDialogElement>('wiki-form').close();
  if (outcome.wiki.ok) loaded = { slug: open.slug, wiki: outcome.wiki.value };
  renderList();
  toast(`Đã lưu trang ${request.page.slug} (${outcome.page.file}).`);
}

// ---- upload ---------------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<UploadOperation['action'], string> = { create: 'Tạo mới', update: 'Cập nhật', skip: 'Bỏ qua' };
const RESULT_LABEL: Record<string, string> = { created: 'Đã tạo', updated: 'Đã cập nhật', unchanged: 'Không đổi' };

function operationTarget(operation: UploadOperation): HTMLElement {
  if (operation.type === 'wiki') return h('td', {}, h('code', {}, operation.slug));
  return h('td', {}, h('code', {}, operation.name), ` → ${operation.target}`);
}

function operationsTable(rows: { operation: UploadOperation; label: string }[]): HTMLElement {
  return h(
    'table',
    { class: 'plan' },
    h('tr', {}, h('th', {}, 'Thao tác'), h('th', {}, 'Loại'), h('th', {}, 'Mục'), h('th', {}, 'File')),
    ...rows.map(({ operation, label }) =>
      h(
        'tr',
        { class: `op-${operation.action}` },
        h('td', {}, label),
        h('td', {}, operation.type === 'wiki' ? 'Trang wiki' : 'Tệp đính kèm'),
        operationTarget(operation),
        h('td', { class: 'muted' }, operation.file),
      ),
    ),
  );
}

function planSummary(plan: UploadPlan): HTMLElement {
  return h('p', {}, `Tạo mới ${plan.summary.create} · Cập nhật ${plan.summary.update} · Bỏ qua ${plan.summary.skip}`);
}

function showUpload(slug: string, title: string, ...content: (HTMLElement | false)[]): void {
  byId('wiki-result').replaceChildren(h('h2', {}, title), h('p', { class: 'muted' }, `Dự án ${slug} · ${new Date().toLocaleTimeString('vi-VN')}`), ...content.filter((node) => node !== false));
}

function uploadOutcome(slug: string, outcome: WikiUploadOutcome): void {
  if (outcome.status === 'cancelled') {
    requireHost().toast('Đã huỷ, chưa ghi gì lên Taiga.');
    const { plan } = outcome;
    return showUpload(slug, 'Đã huỷ đẩy wiki', h('p', {}, 'Chưa ghi gì lên Taiga.'), planSummary(plan), operationsTable(plan.operations.map((operation) => ({ operation, label: ACTION_LABEL[operation.action] }))));
  }
  if (outcome.status === 'no-changes') return showUpload(slug, 'Wiki trên Taiga đã khớp với docs.yaml', h('p', {}, 'Không có gì cần đẩy.'));
  const { report } = outcome;
  showUpload(
    slug,
    'Đã đẩy wiki lên Taiga',
    h('p', {}, `Đã tạo ${report.summary.created} · Đã cập nhật ${report.summary.updated} · Không đổi ${report.summary.unchanged}`),
    operationsTable(report.operations.map((operation) => ({ operation, label: RESULT_LABEL[operation.result] ?? operation.result }))),
  );
}

async function upload(): Promise<void> {
  const { api, view, failureBlock } = requireHost();
  const slug = view()?.slug;
  if (!slug || busy) return;
  busy = true;
  renderButtons();
  byId('wiki-result').replaceChildren(h('p', { class: 'muted' }, 'Đang chạy taigent upload --dry-run…'));
  try {
    const result = await api.uploadWiki(slug);
    if (!result.ok) return showUpload(slug, 'Chưa đẩy được wiki lên Taiga', failureBlock(result));
    uploadOutcome(slug, result.value);
  } finally {
    busy = false;
    renderButtons();
  }
}

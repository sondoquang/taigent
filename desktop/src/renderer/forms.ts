// Forms that write backlog.yaml through the manifest edit API (`src/edit.ts`, via `window.taigent`): the epic, story,
// task and issue forms (the story's own parts are in story-form.ts), the item actions (edit, add story or task, remove),
// the conflict dialog when backlog.yaml changed since a form opened, and the removal warning for items already on
// Taiga. Forms never write review.yaml: a new item is "Chưa duyệt", an edited item that had a verdict turns "Đã đổi
// sau khi duyệt" through its digest.

import { ISSUE_VALUE_FIELDS, type IssueValueField } from '../../../src/items.ts';
import { suggestKey } from '../../../src/manifest/conventions.ts';
import type {
  BacklogSnapshot,
  CustomAttributeSpec,
  Failure,
  ManifestFile,
  ManifestIssue,
  PreviewItem,
  ProjectView,
  Result,
  SaveItemRequest,
  TaigentApi,
} from '../shared/api.ts';
import { changeHunks, lineDiff } from './diff.ts';
import { byId, h } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { storyEditor, type StoryEditor } from './story-form.ts';

/** What the forms need from the main renderer. */
export interface FormsHost {
  api: TaigentApi;
  view(): ProjectView | undefined;
  /** Shows the project as read after a write, selecting `key` when given. */
  showView(view: Result<ProjectView>, key?: string): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  failureBlock(failure: Failure): HTMLElement;
}

type FormType = 'epic' | 'story' | 'task' | 'issue';

interface OpenForm {
  type: FormType;
  slug: string;
  /** The item being edited; absent for a new item. */
  original?: PreviewItem;
  /** backlog.yaml as the form opened it: its digest guards the save, its text is the "before" of a conflict. */
  base: BacklogSnapshot;
  keyTouched: boolean;
  /** The story form's format section and preview. */
  story?: StoryEditor;
}

const TYPE_LABEL: Record<FormType, string> = { epic: 'Epic', story: 'Story', task: 'Task', issue: 'Issue' };

const KEY_HINT: Record<FormType, string> = {
  epic: 'Gợi ý theo quy ước: tên mảng việc, ví dụ AUTH.',
  story: 'Gợi ý theo quy ước: <EPIC>-<việc>, ví dụ AUTH-LOGIN.',
  task: 'Gợi ý theo quy ước: <STORY>-<bước>, ví dụ AUTH-LOGIN-API.',
  issue: 'Gợi ý theo quy ước: tên ngắn của triệu chứng, ví dụ LOGIN-500.',
};

/** The description a new issue starts from: the template of conventions §6.4 (labels stay in English). */
const ISSUE_TEMPLATE = '## Steps to reproduce\n\n1. \n\n## Expected\n\n\n\n## Actual\n\n';

const ISSUE_VALUE_LABEL: Record<IssueValueField, string> = { type: 'Loại (type)', severity: 'Mức độ (severity)', priority: 'Ưu tiên (priority)' };
const TAIGA_VALUES = { type: 'issueTypes', severity: 'severities', priority: 'priorities' } as const;

let host: FormsHost | undefined;
let form: OpenForm | undefined;

function requireHost(): FormsHost {
  if (!host) throw new Error('forms are not mounted');
  return host;
}

/** Every item of the view with its type and parent key, in tree order. */
function allItems(view: ProjectView): PreviewItem[] {
  return view.preview.epics.flatMap((epic) => [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])]);
}

/** The item and every item under it (an epic's stories and tasks, a story's tasks). */
function withChildren(view: ProjectView, item: PreviewItem): PreviewItem[] {
  for (const epic of view.preview.epics) {
    if (epic.key === item.key && item.type === 'epic') return [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])];
    for (const story of epic.stories) {
      if (story.key === item.key && item.type === 'story') return [story, ...story.tasks];
    }
  }
  return [item];
}

// ---- mounting -------------------------------------------------------------------------------------------------

/** Creates the dialogs and the "+ Epic" button, and follows live changes of backlog.yaml while a form is open. */
export function mountForms(formsHost: FormsHost): void {
  host = formsHost;
  document.body.append(
    h('dialog', { id: 'item-form', class: 'modal wide item-form' }, h('form', { id: 'item-form-body', method: 'dialog' })),
    h(
      'dialog',
      { id: 'conflict-dialog', class: 'modal wide' },
      h('div', { id: 'conflict-content' }),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', id: 'conflict-cancel', onclick: () => byId<HTMLDialogElement>('conflict-dialog').close() }, 'Huỷ'),
        h('button', { type: 'button', class: 'btn primary', id: 'conflict-reapply' }, 'Áp lại thay đổi của tôi'),
      ),
    ),
    h(
      'dialog',
      { id: 'remove-dialog', class: 'modal' },
      h('div', { id: 'remove-content' }),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', id: 'remove-cancel', onclick: () => byId<HTMLDialogElement>('remove-dialog').close() }, 'Huỷ'),
        h('button', { type: 'button', class: 'btn danger', id: 'remove-confirm' }, 'Xoá khỏi backlog'),
      ),
    ),
  );
  byId<HTMLDialogElement>('item-form').addEventListener('close', () => (form = undefined));
  const tree = byId('tree');
  tree.before(
    h(
      'div',
      { class: 'form-toolbar' },
      h('button', { type: 'button', class: 'btn small', id: 'add-epic', onclick: () => void openForm('epic') }, '+ Epic'),
    ),
  );
  formsHost.api.onProjectChanged(() => void noticeChange());
}

/** Buttons of the item detail: edit, add a story (epic) or a task (story), remove. */
export function itemActions(item: PreviewItem): HTMLElement {
  const type = item.type;
  return h(
    'div',
    { class: 'item-actions' },
    h('button', { type: 'button', class: 'btn small', 'data-action': 'edit', onclick: () => void openForm(type, item) }, 'Sửa'),
    type === 'epic' &&
      h('button', { type: 'button', class: 'btn small', 'data-action': 'add-story', onclick: () => void openForm('story', undefined, item.key) }, '+ Story'),
    type === 'story' &&
      h('button', { type: 'button', class: 'btn small', 'data-action': 'add-task', onclick: () => void openForm('task', undefined, item.key) }, '+ Task'),
    h('button', { type: 'button', class: 'btn small ghost', 'data-action': 'remove', onclick: () => void confirmRemove(item) }, 'Xoá'),
  );
}

/** The "+ Issue" button of the tree's Issues group: issues sit outside the epic tree. */
export function addIssueButton(): HTMLElement {
  return h('button', { type: 'button', class: 'btn small', id: 'add-issue', onclick: () => void openForm('issue') }, '+ Issue');
}

/** When backlog.yaml changes under an open form (an agent edited it), the form says so; saving then shows the change. */
async function noticeChange(): Promise<void> {
  const open = form;
  if (!open) return;
  const latest = await requireHost().api.readBacklog(open.slug);
  if (form !== open || !latest.ok) return;
  byId('form-stale').hidden = latest.value.file.digest === open.base.file.digest;
}

// ---- epic and task forms --------------------------------------------------------------------------------------

function field(name: string, label: string, control: HTMLElement, hint?: HTMLElement | false): HTMLElement {
  return h('div', { class: 'field', 'data-field': name }, h('label', { class: 'field-label', for: control.id }, label), control, hint, h('p', { class: 'field-error', hidden: true }));
}

function attributeInput(spec: CustomAttributeSpec, value: string | number | boolean | undefined, index: number): HTMLElement {
  const id = `form-attr-${index}`;
  const common = { id, 'data-attribute': spec.name, 'data-kind': spec.type };
  if (spec.type === 'checkbox') return h('input', { ...common, type: 'checkbox', checked: value === true });
  if (spec.type === 'multiline' || spec.type === 'richtext') {
    const area = h('textarea', { ...common, rows: '2' });
    area.value = value === undefined ? '' : String(value);
    return area;
  }
  const input = h('input', { ...common, type: spec.type === 'number' ? 'number' : spec.type === 'date' ? 'date' : spec.type === 'url' ? 'url' : 'text' });
  input.value = value === undefined ? '' : String(value);
  return input;
}

function parentLabel(view: ProjectView, key: string): string {
  for (const epic of view.preview.epics) {
    const story = epic.stories.find((candidate) => candidate.key === key);
    if (story) return `${epic.key} › ${story.key}: ${story.subject}`;
  }
  return key;
}

async function openForm(type: FormType, original?: PreviewItem, parent?: string): Promise<void> {
  const { api, view: currentView, toast } = requireHost();
  const view = currentView();
  if (!view) {
    toast('Chọn dự án trước.', 'error');
    return;
  }
  // A story's form edits its manifest fields (use case, scenarios…), not the description the preview composes; an
  // issue's form edits its type, severity and priority as backlog.yaml names them.
  const edited = (type === 'story' || type === 'issue') && original ? { type, key: original.key } : undefined;
  const snapshot = await api.readBacklog(view.slug, edited);
  if (!snapshot.ok) {
    toast(snapshot.message, 'error');
    return;
  }
  const read = snapshot.value.item;
  const stored = read?.type === 'story' ? read.fields : undefined;
  const storedIssue = read?.type === 'issue' ? read.fields : undefined;
  if (edited && !read) {
    toast(`Không tìm thấy ${type} ${edited.key} trong backlog.yaml.`, 'error');
    return;
  }
  form = { type, slug: view.slug, base: snapshot.value, keyTouched: original !== undefined, ...(original && { original }) };
  const parentKey = original?.parent ?? parent;
  const locked = original?.applied !== undefined;

  const key = h('input', { id: 'form-key', type: 'text', autocomplete: 'off', spellcheck: 'false', disabled: locked });
  key.value = original?.key ?? '';
  const keyHint = h(
    'p',
    { class: 'hint', id: 'form-key-hint' },
    locked ? `Đã có trên Taiga (#${original!.applied!.ref}): key bị khoá. Đổi key sẽ tạo item mới và biến item cũ thành mồ côi.` : KEY_HINT[type],
  );
  const subject = h('input', { id: 'form-subject', type: 'text', autocomplete: 'off' });
  subject.value = original?.subject ?? '';
  const description = h('textarea', { id: 'form-description', rows: type === 'epic' ? '5' : type === 'story' ? '3' : type === 'issue' ? '10' : '4' });
  description.value = (stored ?? storedIssue)?.description ?? original?.description ?? (type === 'task' ? 'Done khi: ' : type === 'issue' ? ISSUE_TEMPLATE : '');
  const tags = h('input', { id: 'form-tags', type: 'text', autocomplete: 'off', placeholder: 'type:feature, area:auth' });
  tags.value = (original?.tags ?? []).join(', ');
  const specInput = type === 'story' && h('input', { id: 'form-spec', type: 'text', autocomplete: 'off', placeholder: 'docs/specs/auth.md hoặc link' });
  if (specInput) specInput.value = stored?.spec ?? '';

  // A story belongs to an epic, a task to a story: choosing another one in the form moves the item there.
  const parents =
    type === 'story'
      ? view.preview.epics.map((epic) => ({ key: epic.key, label: `${epic.key}: ${epic.subject}` }))
      : view.preview.epics.flatMap((epic) => epic.stories.map((story) => ({ key: story.key, label: parentLabel(view, story.key) })));
  const parentSelect =
    (type === 'story' || type === 'task') &&
    h('select', { id: 'form-parent' }, ...parents.map((option) => h('option', { value: option.key, selected: option.key === parentKey }, option.label)));

  // Issue values: free text until `taigent projects --project <slug> --json` lists the project's values (logged in,
  // project on Taiga); then dropdowns. A free-text name that Taiga does not define is reported by plan (`issue-value`).
  const issueValues =
    type === 'issue'
      ? ISSUE_VALUE_FIELDS.map((name) => {
          const input = h('input', { id: `form-${name}`, type: 'text', autocomplete: 'off', 'data-issue-value': name });
          input.value = storedIssue?.[name] ?? '';
          return field(name, ISSUE_VALUE_LABEL[name], input);
        })
      : [];
  const valuesHint = type === 'issue' && h('p', { class: 'hint', id: 'form-values-hint' }, 'Đang đọc type, severity, priority của project trên Taiga…');

  // Custom attributes (epics, stories, issues): those project.yaml declares for the type, then any other the item has.
  const declared = type === 'task' ? [] : snapshot.value.attributes[type];
  const existing = original?.customAttributes ?? {};
  const undeclared = Object.keys(existing)
    .filter((name) => !declared.some((attribute) => attribute.name === name))
    .map((name): CustomAttributeSpec => {
      const value = existing[name];
      return { name, description: '', type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : 'text' };
    });
  const attributes = type === 'task' ? [] : [...declared, ...undeclared];

  const issuePreview = type === 'issue' ? markdownPreview() : undefined;
  const refreshPreview = () => {
    form?.story?.refresh({ description: description.value.trim(), spec: specInput ? specInput.value.trim() : '' });
    issuePreview?.refresh(description.value.trim());
  };
  const story =
    type === 'story'
      ? storyEditor(
          stored?.acceptanceCriteria ? { acceptanceCriteria: stored.acceptanceCriteria } : stored?.useCase && { useCase: stored.useCase, scenarios: stored.scenarios ?? [] },
          refreshPreview,
        )
      : undefined;
  if (story) form.story = story;

  // Issues share the key space with epics, stories and tasks.
  const taken = new Set([...allItems(view), ...view.preview.issues].map((item) => item.key).filter((itemKey) => itemKey !== original?.key));
  const refreshKey = () => {
    if (!form || locked) return;
    if (!form.keyTouched) key.value = suggestKey(subject.value, parentSelect ? parentSelect.value : type === 'task' || type === 'story' ? parentKey : undefined, taken);
    const duplicate = taken.has(key.value.trim());
    keyHint.classList.toggle('error', duplicate);
    keyHint.textContent = duplicate ? `Key ${key.value.trim()} đã có trong backlog: chọn key khác.` : KEY_HINT[type];
  };
  subject.addEventListener('input', refreshKey);
  key.addEventListener('input', () => {
    if (form) form.keyTouched = key.value.trim() !== '';
    refreshKey();
  });
  if (parentSelect) parentSelect.addEventListener('change', refreshKey);

  const body = byId<HTMLFormElement>('item-form-body');
  body.classList.toggle('with-preview', story !== undefined || issuePreview !== undefined);
  body.replaceChildren(
    h(
      'div',
      { class: 'form-fields' },
      h('h2', {}, original ? `Sửa ${TYPE_LABEL[type].toLowerCase()} ${original.key}` : `Thêm ${TYPE_LABEL[type].toLowerCase()}`),
      h('p', { class: 'warn-box', id: 'form-stale', hidden: true }, 'backlog.yaml vừa đổi từ lúc mở form (có thể do agent). Khi lưu, bạn sẽ được xem thay đổi đó rồi áp lại phần của mình.'),
      parentSelect && field('parent', type === 'story' ? 'Thuộc epic' : 'Thuộc story', parentSelect),
      field('subject', 'Tiêu đề', subject),
      field('key', 'Key', key, keyHint),
      story?.element,
      field(
        'description',
        type === 'task' ? 'Định nghĩa done' : type === 'story' ? 'Mô tả thêm (Markdown, tuỳ chọn)' : type === 'issue' ? 'Mô tả (Markdown: bước tái hiện, mong đợi, thực tế)' : 'Mô tả (Markdown)',
        description,
      ),
      ...issueValues,
      valuesHint,
      specInput && field('spec', 'Spec (đường dẫn hoặc link, tuỳ chọn)', specInput),
      field('tags', 'Tag (cách nhau bằng dấu phẩy)', tags),
      attributes.length > 0 &&
        h(
          'fieldset',
          { class: 'field attributes-field', 'data-field': 'custom_attributes' },
          h('legend', {}, 'Thuộc tính (custom attributes trong project.yaml)'),
          ...attributes.map((attribute, index) => {
            const control = attributeInput(attribute, existing[attribute.name], index);
            return h('label', { class: 'attribute', for: control.id }, h('span', {}, attribute.name), control);
          }),
          h('p', { class: 'field-error', hidden: true }),
        ),
      h('ul', { class: 'issues', id: 'form-issues', hidden: true }),
      h('p', { class: 'hint' }, 'Lưu xong, mục ở trạng thái Chưa duyệt; mục đã duyệt sẽ thành Đã đổi sau khi duyệt.'),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', id: 'form-cancel', onclick: () => byId<HTMLDialogElement>('item-form').close() }, 'Huỷ'),
        h('button', { type: 'submit', class: 'btn primary', id: 'form-save' }, 'Lưu vào backlog.yaml'),
      ),
    ),
    ...(story ? [story.preview] : issuePreview ? [issuePreview.element] : []),
  );
  body.onsubmit = (event) => {
    event.preventDefault();
    void submitForm();
  };
  body.oninput = refreshPreview;
  byId<HTMLDialogElement>('item-form').showModal();
  refreshKey();
  refreshPreview();
  subject.focus();
  if (type === 'issue') void loadIssueValues(view.slug);
}

/** A Markdown preview of the issue description, rendered like the review screen (markdown.ts). */
function markdownPreview(): { element: HTMLElement; refresh(text: string): void } {
  const body = h('div', { class: 'markdown', id: 'form-preview-body' });
  const element = h(
    'aside',
    { class: 'form-preview', id: 'form-preview' },
    h('h3', {}, 'Xem trước'),
    h('p', { class: 'hint' }, 'Mô tả đúng như apply sẽ ghi lên Taiga.'),
    body,
  );
  return { element, refresh: (text) => body.replaceChildren(renderMarkdown(text)) };
}

/**
 * Turns the issue value inputs into dropdowns of the project's values on Taiga (Taiga's order), keeping a current
 * value Taiga does not define as an extra option; without them (not logged in, project not on Taiga) the inputs stay
 * free text and the hint says why.
 */
async function loadIssueValues(slug: string): Promise<void> {
  const open = form;
  const detail = await requireHost().api.readTaigaProject(slug);
  if (form !== open || !open) return;
  const hint = byId('form-values-hint');
  const taiga = detail.ok ? detail.value.taiga : undefined;
  if (!taiga) {
    const why = detail.ok ? detail.value.taigaMessage : detail.message;
    hint.textContent = `Nhập tự do${why ? ` (${why})` : ''}: "Xem thay đổi trên Taiga" (plan) sẽ kiểm tên với project.`;
    return;
  }
  for (const name of ISSUE_VALUE_FIELDS) {
    const input = byId<HTMLInputElement>(`form-${name}`);
    const current = input.value.trim();
    const names: readonly string[] = taiga[TAIGA_VALUES[name]];
    const select = h(
      'select',
      { id: `form-${name}`, 'data-issue-value': name },
      h('option', { value: '', selected: current === '' }, '— chọn —'),
      ...names.map((value) => h('option', { value, selected: value === current }, value)),
      current !== '' && !names.includes(current) && h('option', { value: current, selected: true }, `${current} (không có trên Taiga)`),
    );
    input.replaceWith(select);
  }
  hint.textContent = 'Giá trị của project trên Taiga (taigent projects --project <slug> --json).';
}

function attributeValues(): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  const existing = form?.original?.customAttributes ?? {};
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('#item-form [data-attribute]')) {
    const name = control.dataset.attribute!;
    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (control.checked || name in existing) values[name] = control.checked;
      continue;
    }
    const text = control.value.trim();
    if (text === '') continue;
    values[name] = control.dataset.kind === 'number' && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  return values;
}

function formRequest(open: OpenForm): SaveItemRequest {
  const key = byId<HTMLInputElement>('form-key').value.trim();
  const fields = {
    subject: byId<HTMLInputElement>('form-subject').value.trim(),
    description: byId<HTMLTextAreaElement>('form-description').value.trim(),
    tags: byId<HTMLInputElement>('form-tags').value.split(/[\s,]+/).filter(Boolean),
  };
  const original = open.original ? { original: open.original.key } : {};
  if (open.type === 'epic') return { baseDigest: open.base.file.digest, ...original, item: { type: 'epic', key, fields: { ...fields, customAttributes: attributeValues() } } };
  if (open.type === 'issue') {
    const value = (name: IssueValueField) => byId<HTMLInputElement | HTMLSelectElement>(`form-${name}`).value.trim();
    const issue = { ...fields, type: value('type'), severity: value('severity'), priority: value('priority'), customAttributes: attributeValues() };
    return { baseDigest: open.base.file.digest, ...original, item: { type: 'issue', key, fields: issue } };
  }
  const parent = byId<HTMLSelectElement>('form-parent').value;
  if (open.type === 'story') {
    const story = { ...fields, spec: byId<HTMLInputElement>('form-spec').value.trim(), customAttributes: attributeValues(), ...open.story!.format() };
    return { baseDigest: open.base.file.digest, ...original, item: { type: 'story', key, parent, fields: story } };
  }
  return { baseDigest: open.base.file.digest, ...original, item: { type: 'task', key, parent, fields } };
}

/**
 * Puts each issue next to the part of the form its path names, the most specific one there is (`…scenarios[1].when`,
 * else `…scenarios[1]`, else `…scenarios`; `…tags[1]` → tags); the others go to the list under the form.
 */
function showIssues(issues: ManifestIssue[]): void {
  for (const error of document.querySelectorAll<HTMLElement>('#item-form .field-error')) {
    error.hidden = true;
    error.textContent = '';
  }
  const general: ManifestIssue[] = [];
  for (const issue of issues) {
    let at = issue.path.replace(/^(?:issues\[\d+\]|epics\[\d+\](?:\.stories\[\d+\](?:\.tasks\[\d+\])?)?)\.?/, '');
    let error: HTMLElement | null = null;
    while (at !== '' && !error) {
      const name = CSS.escape(at);
      error = document.querySelector<HTMLElement>(`#item-form [data-path="${name}"] > .field-error, #item-form .field[data-field="${name}"] > .field-error`);
      const parentPath = at.replace(/(?:\.[^.[\]]+|\[\d+\])$/, '');
      at = parentPath === at ? '' : parentPath;
    }
    if (!error) {
      general.push(issue);
      continue;
    }
    error.textContent = `${error.textContent ? `${error.textContent} ` : ''}${issue.message} [${issue.rule}]`;
    error.hidden = false;
  }
  const list = byId('form-issues');
  list.replaceChildren(...general.map((issue) => h('li', {}, issue.path && h('code', {}, issue.path), ` ${issue.message} `, h('span', { class: 'muted' }, `[${issue.rule}]`))));
  list.hidden = general.length === 0;
}

async function submitForm(): Promise<void> {
  const open = form;
  if (!open) return;
  await save(open, formRequest(open));
}

/** Sends one save; a conflict opens the conflict dialog, whose "Áp lại" sends it again on the current file. */
async function save(open: OpenForm, request: SaveItemRequest): Promise<void> {
  const { api, showView, toast, failureBlock } = requireHost();
  const button = byId<HTMLButtonElement>('form-save');
  button.disabled = true;
  const result = await api.saveItem(open.slug, request).finally(() => (button.disabled = false));
  if (!result.ok) {
    showIssues([]);
    const list = byId('form-issues');
    list.replaceChildren(h('li', {}, failureBlock(result)));
    list.hidden = false;
    return;
  }
  const outcome = result.value;
  if (outcome.status === 'invalid') {
    showIssues(outcome.issues);
    return;
  }
  if (outcome.status === 'conflict') {
    showConflict(open.base.file, outcome.current, () => {
      open.base = { ...open.base, file: outcome.current };
      byId('form-stale').hidden = true;
      void save(open, { ...request, baseDigest: outcome.current.digest });
    });
    return;
  }
  byId<HTMLDialogElement>('item-form').close();
  showView(outcome.view, request.item.key);
  toast(`Đã lưu ${request.item.key} vào backlog.yaml.`);
}

// ---- conflict -------------------------------------------------------------------------------------------------

/** Shows what changed in backlog.yaml since `base` (lines removed and added), with "Áp lại" running `reapply`. */
function showConflict(base: ManifestFile, current: ManifestFile, reapply: () => void): void {
  const hunks = changeHunks(lineDiff(base.text, current.text));
  byId('conflict-content').replaceChildren(
    h('h2', {}, 'backlog.yaml đã đổi từ lúc bạn mở form'),
    h(
      'p',
      {},
      'Chưa có gì được ghi. Có người (thường là agent) vừa sửa file. Xem thay đổi dưới đây; bấm "Áp lại thay đổi của tôi" để ghi phần của bạn lên bản mới, hoặc Huỷ để giữ nguyên.',
    ),
    hunks.length === 0
      ? h('p', { class: 'muted' }, 'Nội dung giống nhau, chỉ khác cách xuống dòng.')
      : h(
          'pre',
          { class: 'diff', id: 'conflict-diff' },
          ...hunks.map((line) =>
            line === undefined
              ? h('span', { class: 'diff-gap' }, '…\n')
              : h('span', { class: `diff-${line.kind}` }, `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}\n`),
          ),
        ),
  );
  byId('conflict-reapply').onclick = () => {
    byId<HTMLDialogElement>('conflict-dialog').close();
    reapply();
  };
  byId<HTMLDialogElement>('conflict-dialog').showModal();
}

// ---- removal --------------------------------------------------------------------------------------------------

const KIND_LABEL: Record<PreviewItem['type'], string> = { epic: 'epic', story: 'story', task: 'task', issue: 'issue' };

async function confirmRemove(item: PreviewItem): Promise<void> {
  const { api, view: currentView, toast } = requireHost();
  const view = currentView();
  if (!view) return;
  const snapshot = await api.readBacklog(view.slug);
  if (!snapshot.ok) {
    toast(snapshot.message, 'error');
    return;
  }
  const removed = withChildren(view, item);
  const children = removed.slice(1);
  const onTaiga = removed.filter((candidate) => candidate.applied !== undefined);
  byId('remove-content').replaceChildren(
    h(
      'div',
      {},
      h('h2', {}, `Xoá ${KIND_LABEL[item.type]} ${item.key}?`),
      h('p', {}, `“${item.subject}” sẽ bị xoá khỏi backlog.yaml.`),
      children.length > 0 &&
        h('p', {}, `Kèm theo ${children.length} mục bên dưới: `, h('code', {}, children.map((child) => child.key).join(', ')), '.'),
      onTaiga.length > 0 &&
        h(
          'div',
          { class: 'warn-box', id: 'remove-orphans' },
          h('strong', {}, 'Mục đã có trên Taiga sẽ thành mồ côi. '),
          `Xoá khỏi manifest không xoá chúng trên Taiga: ${onTaiga.map((candidate) => `${candidate.key} (#${candidate.applied!.ref})`).join(', ')} vẫn còn đó, và “Xem thay đổi trên Taiga” sẽ báo chúng là mồ côi để người quyết định.`,
        ),
    ),
  );
  byId('remove-confirm').onclick = () => {
    byId<HTMLDialogElement>('remove-dialog').close();
    void remove(view.slug, item, snapshot.value.file);
  };
  byId<HTMLDialogElement>('remove-dialog').showModal();
}

async function remove(slug: string, item: PreviewItem, base: ManifestFile): Promise<void> {
  const { api, showView, toast } = requireHost();
  const result = await api.removeItem(slug, { baseDigest: base.digest, type: item.type, key: item.key });
  if (!result.ok) {
    toast(result.message, 'error');
    return;
  }
  const outcome = result.value;
  if (outcome.status === 'conflict') {
    showConflict(base, outcome.current, () => void remove(slug, item, outcome.current));
    return;
  }
  if (outcome.status === 'invalid') {
    toast(outcome.issues.map((issue) => issue.message).join('; '), 'error');
    return;
  }
  showView(outcome.view);
  toast(
    outcome.orphaned.length > 0
      ? `Đã xoá ${outcome.removed.join(', ')}. Trên Taiga còn ${outcome.orphaned.join(', ')} (mồ côi).`
      : `Đã xoá ${outcome.removed.join(', ')}.`,
  );
}

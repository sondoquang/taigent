// The item form: adds or edits an epic, story, task or issue in backlog.yaml through the manifest edit API
// (`src/edit.ts`, via `window.taigent`), with a Markdown preview of what apply writes to Taiga. The story's own parts
// are in story-editor.tsx. A save names the digest of backlog.yaml as the form read it: when an agent changed the file
// since, the form says so at once and the save opens the conflict dialog, whose "Áp lại" saves on the current file.
// Forms never write review.yaml: a new item is "Chưa duyệt", an edited item that had a verdict turns "Đã đổi sau khi
// duyệt" through its digest.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ISSUE_VALUE_FIELDS, type IssueValueField } from '../../../../../../src/items.ts';
import { issueKeyPrefix, suggestKey } from '../../../../../../src/manifest/conventions.ts';
import { storyDescription } from '../../../../../../src/story-template.ts';
import type { CustomAttributeSpec, Failure, ItemType, ManifestIssue, ProjectView, SaveItemRequest } from '../../../../shared/api.ts';
import { applyView, toast } from '@/actions.ts';
import { TYPE_LABEL } from '@/components/common.tsx';
import { showConflict } from '@/components/conflict-dialog.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Markdown } from '@/components/markdown.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import { api } from '@/store.ts';
import { allItems, closeForm, type OpenForm, updateForm, useForms } from './forms-store.ts';
import { initialStory, StoryEditor, storyErrorKeys, storyFormat } from './story-editor.tsx';

const KEY_HINT: Record<ItemType, string> = {
  epic: 'Gợi ý theo quy ước: tên mảng việc, ví dụ AUTH.',
  story: 'Gợi ý theo quy ước: <EPIC>-<việc>, ví dụ AUTH-LOGIN.',
  task: 'Gợi ý theo quy ước: <STORY>-<bước>, ví dụ AUTH-LOGIN-API.',
  issue: 'Gợi ý theo quy ước: BUG-, ASK- (Question) hoặc ENH- (Enhancement) rồi tên ngắn, ví dụ BUG-LOGIN-500.',
};

const DESCRIPTION_ROWS: Record<ItemType, number> = { epic: 5, story: 3, task: 4, issue: 10 };

const DESCRIPTION_LABEL: Record<ItemType, string> = {
  epic: 'Mô tả (Markdown)',
  story: 'Mô tả thêm (Markdown, tuỳ chọn)',
  task: 'Định nghĩa done',
  issue: 'Mô tả (Markdown: bước tái hiện, mong đợi, thực tế)',
};

/** The description a new issue starts from: the template of conventions §6.4 (labels stay in English). */
const ISSUE_TEMPLATE = '## Steps to reproduce\n\n1. \n\n## Expected\n\n\n\n## Actual\n\n';

const ISSUE_VALUE_LABEL: Record<IssueValueField, string> = { type: 'Loại (type)', severity: 'Mức độ (severity)', priority: 'Ưu tiên (priority)' };
const TAIGA_VALUES = { type: 'issueTypes', severity: 'severities', priority: 'priorities' } as const;

const INPUT_TYPE: Partial<Record<CustomAttributeSpec['type'], string>> = { number: 'number', date: 'date', url: 'url' };

/** Strips the item's own place in backlog.yaml from an issue path: `epics[0].stories[1].scenarios[1].when` → `scenarios[1].when`. */
const ITEM_PATH = /^(?:issues\[\d+\]|epics\[\d+\](?:\.stories\[\d+\](?:\.tasks\[\d+\])?)?)\.?/;

function parentLabel(view: ProjectView, key: string): string {
  for (const epic of view.preview.epics) {
    const story = epic.stories.find((candidate) => candidate.key === key);
    if (story) return `${epic.key} › ${story.key}: ${story.subject}`;
  }
  return key;
}

/**
 * Puts each issue next to the part of the form its path names, the most specific one there is (`…scenarios[1].when`,
 * else `…scenarios[1]`, else `…scenarios`; `…tags[1]` → tags); the others go to the list under the form. `known` maps
 * each path the form shows errors for to the key its error is kept under.
 */
function placeIssues(issues: ManifestIssue[], known: ReadonlyMap<string, string>): { errors: Record<string, string>; general: ManifestIssue[] } {
  const errors: Record<string, string> = {};
  const general: ManifestIssue[] = [];
  for (const issue of issues) {
    let at = issue.path.replace(ITEM_PATH, '');
    while (at !== '' && !known.has(at)) {
      const parentPath = at.replace(/(?:\.[^.[\]]+|\[\d+\])$/, '');
      at = parentPath === at ? '' : parentPath;
    }
    const key = known.get(at);
    if (key === undefined) {
      general.push(issue);
      continue;
    }
    const text = `${issue.message} [${issue.rule}]`;
    errors[key] = errors[key] ? `${errors[key]} ${text}` : text;
  }
  return { errors, general };
}

/** The open form's dialog content; mounted afresh for every opening (keyed by `form.id`). */
export function ItemForm({ form }: { form: OpenForm }) {
  const { type, view, original } = form;
  const read = form.base.item;
  const stored = read?.type === 'story' ? read.fields : undefined;
  const storedIssue = read?.type === 'issue' ? read.fields : undefined;
  const locked = original?.applied !== undefined;

  // A story belongs to an epic, a task to a story: choosing another one in the form moves the item there.
  const parents = useMemo(
    () =>
      type === 'story'
        ? view.preview.epics.map((epic) => ({ key: epic.key, label: `${epic.key}: ${epic.subject}` }))
        : type === 'task'
          ? view.preview.epics.flatMap((epic) => epic.stories.map((story) => ({ key: story.key, label: parentLabel(view, story.key) })))
          : [],
    [type, view],
  );
  // Issues share the key space with epics, stories and tasks.
  const taken = useMemo(
    () => new Set([...allItems(view), ...view.preview.issues].map((item) => item.key).filter((key) => key !== original?.key)),
    [view, original],
  );
  // Custom attributes (epics, stories, issues): those project.yaml declares for the type, then any other the item has.
  const existing = useMemo(() => original?.customAttributes ?? {}, [original]);
  const attributes = useMemo((): CustomAttributeSpec[] => {
    if (type === 'task') return [];
    const declared = form.base.attributes[type];
    const undeclared = Object.entries(existing)
      .filter(([name]) => !declared.some((attribute) => attribute.name === name))
      .map(([name, value]): CustomAttributeSpec => ({ name, description: '', type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : 'text' }));
    return [...declared, ...undeclared];
  }, [type, form.base.attributes, existing]);

  const [subject, setSubject] = useState(original?.subject ?? '');
  const [typedKey, setTypedKey] = useState(original?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(original !== undefined);
  const [description, setDescription] = useState(
    () => (stored ?? storedIssue)?.description ?? original?.description ?? (type === 'task' ? 'Done khi: ' : type === 'issue' ? ISSUE_TEMPLATE : ''),
  );
  const [tags, setTags] = useState((original?.tags ?? []).join(', '));
  const [spec, setSpec] = useState(stored?.spec ?? '');
  const [parent, setParent] = useState(() => {
    const wanted = original?.parent ?? form.parent;
    return parents.some((option) => option.key === wanted) ? wanted! : (parents[0]?.key ?? '');
  });
  const [values, setValues] = useState<Record<IssueValueField, string>>({
    type: storedIssue?.type ?? '',
    severity: storedIssue?.severity ?? '',
    priority: storedIssue?.priority ?? '',
  });
  const [taigaValues, setTaigaValues] = useState<Record<IssueValueField, readonly string[]>>();
  const [valuesHint, setValuesHint] = useState('Đang đọc type, severity, priority của project trên Taiga…');
  const [attributeDrafts, setAttributeDrafts] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(attributes.map((spec) => [spec.name, spec.type === 'checkbox' ? existing[spec.name] === true : String(existing[spec.name] ?? '')])),
  );
  const [story, setStory] = useState(() => (type === 'story' ? initialStory(stored) : undefined));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<ManifestIssue[]>([]);
  const [failure, setFailure] = useState<Failure>();
  const [pending, setPending] = useState(false);
  const subjectInput = useRef<HTMLInputElement>(null);

  const showsParent = type === 'story' || type === 'task';
  const keyParent = showsParent ? parent : type === 'issue' ? issueKeyPrefix(values.type) : undefined;
  const key = locked ? original!.key : keyTouched ? typedKey : suggestKey(subject, keyParent, taken);
  const duplicate = !locked && taken.has(key.trim());

  // Issue values: free text until `taigent projects --project <slug> --json` lists the project's values (logged in,
  // project on Taiga); then dropdowns in Taiga's order. A free-text name Taiga does not define is reported by plan.
  useEffect(() => {
    if (type !== 'issue') return;
    let current = true;
    void api.readTaigaProject(form.slug).then((detail) => {
      if (!current) return;
      const taiga = detail.ok ? detail.value.taiga : undefined;
      if (!taiga) {
        const why = detail.ok ? detail.value.taigaMessage : detail.message;
        setValuesHint(`Nhập tự do${why ? ` (${why})` : ''}: "Xem thay đổi trên Taiga" (plan) sẽ kiểm tên với project.`);
        return;
      }
      setValues((typed) => ({ type: typed.type.trim(), severity: typed.severity.trim(), priority: typed.priority.trim() }));
      setTaigaValues({ type: taiga[TAIGA_VALUES.type], severity: taiga[TAIGA_VALUES.severity], priority: taiga[TAIGA_VALUES.priority] });
      setValuesHint('Giá trị của project trên Taiga (taigent projects --project <slug> --json).');
    });
    return () => {
      current = false;
    };
  }, [type, form.slug]);

  // When backlog.yaml changes under the open form (an agent edited it), the form says so; saving then shows the change.
  useEffect(
    () =>
      api.onProjectChanged(() => {
        void api.readBacklog(form.slug).then((latest) => {
          const open = useForms.getState().form;
          if (open?.id !== form.id || !latest.ok) return;
          updateForm(form.id, { stale: latest.value.file.digest !== open.base.file.digest });
        });
      }),
    [form.id, form.slug],
  );

  // The story preview composes the whole description (the core story template); the others show their description.
  const preview = useMemo(() => {
    if (!story) return undefined;
    const format = storyFormat(story);
    const text = { description: description.trim(), spec: spec.trim() };
    return storyDescription('acceptanceCriteria' in format ? { format: 'legacy', ...format, ...text } : { format: 'user-story', ...format, ...text });
  }, [story, description, spec]);

  function attributeValues(): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const spec of attributes) {
      const value = attributeDrafts[spec.name];
      if (typeof value === 'boolean') {
        if (value || spec.name in existing) result[spec.name] = value;
        continue;
      }
      const text = (value ?? '').trim();
      if (text === '') continue;
      result[spec.name] = spec.type === 'number' && Number.isFinite(Number(text)) ? Number(text) : text;
    }
    return result;
  }

  function request(): SaveItemRequest {
    const baseDigest = useForms.getState().form?.base.file.digest ?? form.base.file.digest;
    const itemKey = key.trim();
    const fields = { subject: subject.trim(), description: description.trim(), tags: tags.split(/[\s,]+/).filter(Boolean) };
    const edited = original ? { original: original.key } : {};
    if (type === 'epic') return { baseDigest, ...edited, item: { type, key: itemKey, fields: { ...fields, customAttributes: attributeValues() } } };
    if (type === 'issue') {
      const issue = { ...fields, type: values.type.trim(), severity: values.severity.trim(), priority: values.priority.trim(), customAttributes: attributeValues() };
      return { baseDigest, ...edited, item: { type, key: itemKey, fields: issue } };
    }
    if (type === 'story') {
      const fieldsOfStory = { ...fields, spec: spec.trim(), customAttributes: attributeValues(), ...storyFormat(story!) };
      return { baseDigest, ...edited, item: { type, key: itemKey, parent, fields: fieldsOfStory } };
    }
    return { baseDigest, ...edited, item: { type, key: itemKey, parent, fields } };
  }

  function showIssues(issues: ManifestIssue[]): void {
    const known = new Map<string, string>(
      [
        'subject',
        'key',
        'description',
        'tags',
        ...(showsParent ? ['parent'] : []),
        ...(type === 'issue' ? ISSUE_VALUE_FIELDS : []),
        ...(type === 'story' ? ['spec'] : []),
        ...(attributes.length > 0 ? ['custom_attributes'] : []),
      ].map((path) => [path, path]),
    );
    if (story) for (const [path, errorKey] of storyErrorKeys(story)) known.set(path, errorKey);
    const placed = placeIssues(issues, known);
    setErrors(placed.errors);
    setGeneral(placed.general);
    setFailure(undefined);
  }

  /** Sends one save; a conflict opens the conflict dialog, whose "Áp lại" sends it again on the current file. */
  async function save(sent: SaveItemRequest): Promise<void> {
    setPending(true);
    const result = await api.saveItem(form.slug, sent).finally(() => setPending(false));
    if (!result.ok) {
      showIssues([]);
      setFailure(result);
      return;
    }
    const outcome = result.value;
    if (outcome.status === 'invalid') {
      showIssues(outcome.issues);
      return;
    }
    if (outcome.status === 'conflict') {
      const open = useForms.getState().form;
      if (open?.id !== form.id) return;
      showConflict(open.base.file, outcome.current, () => {
        updateForm(form.id, { base: { ...open.base, file: outcome.current }, stale: false });
        void save({ ...sent, baseDigest: outcome.current.digest });
      });
      return;
    }
    closeForm();
    applyView(outcome.view, sent.item.key);
    toast(`Đã lưu ${sent.item.key} vào backlog.yaml.`);
  }

  const field = (name: string) => ({ className: 'field', 'data-field': name, 'data-invalid': errors[name] ? true : undefined });
  const fieldError = (name: string) => errors[name] && <FieldError className="field-error">{errors[name]}</FieldError>;
  const invalid = (name: string) => (errors[name] ? true : undefined);

  return (
    <DialogContent
      id="item-form"
      className="item-form flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-4xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        subjectInput.current?.focus();
      }}
    >
      <form
        id="item-form-body"
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void save(request());
        }}
      >
        <DialogHeader className="border-b p-6 pb-4">
          <DialogTitle>{original ? `Sửa ${TYPE_LABEL[type].toLowerCase()} ${original.key}` : `Thêm ${TYPE_LABEL[type].toLowerCase()}`}</DialogTitle>
          <DialogDescription>Lưu xong, mục ở trạng thái Chưa duyệt; mục đã duyệt sẽ thành Đã đổi sau khi duyệt.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <FieldGroup className="form-fields min-w-0 gap-6">
              {form.stale && (
                <p id="form-stale" role="status" className="warn-box rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  backlog.yaml vừa đổi từ lúc mở form (có thể do agent). Khi lưu, bạn sẽ được xem thay đổi đó rồi áp lại phần của mình.
                </p>
              )}
              {showsParent && (
                <Field {...field('parent')}>
                  <FieldLabel htmlFor="form-parent">{type === 'story' ? 'Thuộc epic' : 'Thuộc story'}</FieldLabel>
                  <NativeSelect id="form-parent" value={parent} aria-invalid={invalid('parent')} onChange={(event) => setParent(event.target.value)}>
                    {parents.map((option) => (
                      <NativeSelectOption key={option.key} value={option.key}>
                        {option.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {fieldError('parent')}
                </Field>
              )}
              <Field {...field('subject')}>
                <FieldLabel htmlFor="form-subject">Tiêu đề</FieldLabel>
                <Input
                  id="form-subject"
                  ref={subjectInput}
                  autoComplete="off"
                  aria-invalid={invalid('subject')}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
                {fieldError('subject')}
              </Field>
              <Field {...field('key')} data-invalid={errors.key || duplicate ? true : undefined}>
                <FieldLabel htmlFor="form-key">Key</FieldLabel>
                <Input
                  id="form-key"
                  className=""
                  autoComplete="off"
                  spellCheck={false}
                  disabled={locked}
                  aria-invalid={errors.key || duplicate ? true : undefined}
                  aria-describedby="form-key-hint"
                  value={key}
                  onChange={(event) => {
                    setTypedKey(event.target.value);
                    setKeyTouched(event.target.value.trim() !== '');
                  }}
                />
                <FieldDescription id="form-key-hint" aria-live="polite" className={cn('hint', duplicate && 'error text-destructive')}>
                  {locked
                    ? `Đã có trên Taiga (#${original!.applied!.ref}): key bị khoá. Đổi key sẽ tạo item mới và biến item cũ thành mồ côi.`
                    : duplicate
                      ? `Key ${key.trim()} đã có trong backlog: chọn key khác.`
                      : KEY_HINT[type]}
                </FieldDescription>
                {fieldError('key')}
              </Field>
              {story && <StoryEditor draft={story} onChange={setStory} errors={errors} />}
              <Field {...field('description')}>
                <FieldLabel htmlFor="form-description">{DESCRIPTION_LABEL[type]}</FieldLabel>
                <Textarea
                  id="form-description"
                  rows={DESCRIPTION_ROWS[type]}
                  aria-invalid={invalid('description')}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
                {fieldError('description')}
              </Field>
              {type === 'issue' && (
                <>
                  {ISSUE_VALUE_FIELDS.map((name) => {
                    const names = taigaValues?.[name];
                    const current = values[name];
                    const change = (value: string) => setValues((typed) => ({ ...typed, [name]: value }));
                    return (
                      <Field key={name} {...field(name)}>
                        <FieldLabel htmlFor={`form-${name}`}>{ISSUE_VALUE_LABEL[name]}</FieldLabel>
                        {names ? (
                          <NativeSelect
                            id={`form-${name}`}
                            data-issue-value={name}
                            aria-invalid={invalid(name)}
                            value={current}
                            onChange={(event) => change(event.target.value)}
                          >
                            <NativeSelectOption value="">— chọn —</NativeSelectOption>
                            {names.map((value) => (
                              <NativeSelectOption key={value} value={value}>
                                {value}
                              </NativeSelectOption>
                            ))}
                            {current !== '' && !names.includes(current) && <NativeSelectOption value={current}>{`${current} (không có trên Taiga)`}</NativeSelectOption>}
                          </NativeSelect>
                        ) : (
                          <Input
                            id={`form-${name}`}
                            data-issue-value={name}
                            autoComplete="off"
                            aria-invalid={invalid(name)}
                            value={current}
                            onChange={(event) => change(event.target.value)}
                          />
                        )}
                        {fieldError(name)}
                      </Field>
                    );
                  })}
                  <FieldDescription id="form-values-hint" aria-live="polite" className="hint">
                    {valuesHint}
                  </FieldDescription>
                </>
              )}
              {type === 'story' && (
                <Field {...field('spec')}>
                  <FieldLabel htmlFor="form-spec">Spec (đường dẫn hoặc link, tuỳ chọn)</FieldLabel>
                  <Input
                    id="form-spec"
                    autoComplete="off"
                    placeholder="docs/specs/auth.md hoặc link"
                    aria-invalid={invalid('spec')}
                    value={spec}
                    onChange={(event) => setSpec(event.target.value)}
                  />
                  {fieldError('spec')}
                </Field>
              )}
              <Field {...field('tags')}>
                <FieldLabel htmlFor="form-tags">Tag (cách nhau bằng dấu phẩy)</FieldLabel>
                <Input
                  id="form-tags"
                  autoComplete="off"
                  placeholder="type:feature, area:auth"
                  aria-invalid={invalid('tags')}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                />
                {fieldError('tags')}
              </Field>
              {attributes.length > 0 && (
                <FieldSet className="field attributes-field gap-4" data-field="custom_attributes" data-invalid={invalid('custom_attributes')}>
                  <FieldLegend variant="label">Thuộc tính (custom attributes trong project.yaml)</FieldLegend>
                  {attributes.map((spec, index) => {
                    const id = `form-attr-${index}`;
                    const value = attributeDrafts[spec.name];
                    const common = { id, 'data-attribute': spec.name, 'data-kind': spec.type };
                    const setValue = (next: string | boolean) => setAttributeDrafts((drafts) => ({ ...drafts, [spec.name]: next }));
                    if (spec.type === 'checkbox') {
                      return (
                        <Field key={spec.name} orientation="horizontal" className="attribute">
                          <Checkbox {...common} checked={value === true} onCheckedChange={(checked) => setValue(checked === true)} />
                          <FieldLabel htmlFor={id}>{spec.name}</FieldLabel>
                        </Field>
                      );
                    }
                    return (
                      <Field key={spec.name} className="attribute gap-2">
                        <FieldLabel htmlFor={id}>{spec.name}</FieldLabel>
                        {spec.type === 'multiline' || spec.type === 'richtext' ? (
                          <Textarea {...common} rows={2} value={String(value ?? '')} onChange={(event) => setValue(event.target.value)} />
                        ) : (
                          <Input {...common} type={INPUT_TYPE[spec.type] ?? 'text'} value={String(value ?? '')} onChange={(event) => setValue(event.target.value)} />
                        )}
                        {spec.description && <FieldDescription>{spec.description}</FieldDescription>}
                      </Field>
                    );
                  })}
                  {fieldError('custom_attributes')}
                </FieldSet>
              )}
              {failure ? (
                <div id="form-issues" aria-live="polite">
                  <FailureBlock failure={failure} />
                </div>
              ) : (
                general.length > 0 && (
                  <ul
                    id="form-issues"
                    role="alert"
                    className="issues list-disc space-y-1 rounded-md border border-destructive/30 bg-destructive/10 py-3 pr-3 pl-7 text-sm text-destructive"
                  >
                    {general.map((issue, index) => (
                      <li key={index}>
                        {issue.path && <code className="text-xs text-foreground">{issue.path}</code>} {issue.message}{' '}
                        <span className="text-muted-foreground">[{issue.rule}]</span>
                      </li>
                    ))}
                  </ul>
                )
              )}
            </FieldGroup>
            <aside id="form-preview" className="form-preview flex min-w-0 flex-col gap-2 self-start rounded-lg border bg-card p-4 lg:sticky lg:top-0">
              <h3 className="text-sm font-semibold">Xem trước</h3>
              {preview === undefined ? (
                <>
                  <p className="text-xs text-muted-foreground">Mô tả đúng như apply sẽ ghi lên Taiga.</p>
                  <Markdown id="form-preview-body" text={description.trim()} empty={null} className="min-w-0 break-words" />
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">Mô tả đúng như apply sẽ ghi lên Taiga (cùng mẫu với taigent preview).</p>
                  <Markdown id="form-preview-body" text={preview} className="min-w-0 break-words" />
                  <details className="text-sm">
                    <summary className="cursor-pointer rounded-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                      Markdown
                    </summary>
                    <pre id="form-preview-source" className="detail-text mt-2 max-h-80 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                      {preview}
                    </pre>
                  </details>
                </>
              )}
            </aside>
          </div>
        </div>
        <DialogFooter className="border-t p-6 pt-4">
          <Button type="button" variant="outline" id="form-cancel" onClick={closeForm}>
            Huỷ
          </Button>
          <Button type="submit" id="form-save" disabled={pending}>
            {pending && <Spinner />}
            Lưu vào backlog.yaml
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

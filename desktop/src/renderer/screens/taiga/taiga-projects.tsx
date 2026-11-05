// Taiga > Project: the user's Taiga projects and the repository's manifest directories, one project's detail (its
// issue values on Taiga), the project.yaml form and bootstrap. Reads go through `taigent projects`; the form writes
// project.yaml only (taigent's project-settings API); Taiga is written only by `bootstrap --yes`, after the main
// process's native confirmation. The list loads when the section shows for a repository it has not listed yet.

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { PROJECT_MODULES, PROJECT_TEMPLATES, projectSlug, REQUIRED_MODULES } from '../../../../../src/manifest/conventions.ts';
import type {
  BootstrapOutcome,
  Failure,
  ManifestIssue,
  ProjectSettings,
  TaigaProjectDetail,
  TaigaProjectRow,
  TaigaProjectsOverview,
} from '../../../shared/api.ts';
import { openProject, refreshRepo, showSection, toast } from '@/actions.ts';
import { Code, TableSkeleton } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { api, useApp } from '@/store.ts';
import { cn } from '@/lib/utils.ts';

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

/** What is running: the list read, a project's read (`open:<slug>`), the save or bootstrap. Buttons wait for it. */
type Busy = 'list' | `open:${string}` | 'save' | 'bootstrap' | undefined;

const NEW_PROJECT: ProjectSettings = { name: '', description: '', template: 'scrum', isPrivate: true, modules: ['epics', 'backlog', 'wiki'] };

function rowState(row: TaigaProjectRow): string {
  if (row.hasBacklog) return 'Có backlog.yaml';
  if (row.hasProjectYaml) return 'Có project.yaml';
  return row.manifest ? 'Có thư mục, chưa có project.yaml' : 'Chưa có manifest';
}

function formFor(found: TaigaProjectDetail): FormState {
  const fromTaiga = found.taiga ? { ...NEW_PROJECT, name: found.taiga.project.name } : NEW_PROJECT;
  return { slug: found.slug, baseDigest: found.file.digest, settings: found.file.settings ?? fromTaiga, issues: found.file.issues, dirty: false, conflict: false };
}

function slugHint(form: FormState): string {
  if (form.slug !== undefined) return form.slug;
  const name = form.settings.name.trim();
  return name ? projectSlug(name) || '(tên chưa cho ra slug)' : '(theo tên project)';
}

function bootstrapResult(outcome: BootstrapOutcome): ReactNode {
  if (outcome.status === 'no-changes') return <p>Project trên Taiga đã khớp project.yaml: không có gì để làm.</p>;
  if (outcome.status === 'cancelled') return <p>Đã huỷ bootstrap, chưa ghi gì lên Taiga.</p>;
  const { project, summary } = outcome.report;
  return (
    <p className="text-success">
      Đã bootstrap project #{project.id} ({project.slug}): tạo {summary.created}, cập nhật {summary.updated}, giữ nguyên {summary.unchanged}.
    </p>
  );
}

function ProjectList({
  overview,
  failure,
  hasRepo,
  selected,
  busy,
  onOpen,
}: {
  overview: TaigaProjectsOverview | undefined;
  failure: Failure | undefined;
  hasRepo: boolean;
  selected: string | undefined;
  busy: Busy;
  onOpen(slug: string): void;
}) {
  if (!hasRepo) return null;
  if (failure) return <FailureBlock failure={failure} />;
  // Edge to edge in the card, as Medusa's tables: the header band and the row dividers reach the card's sides.
  if (!overview) return <TableSkeleton rows={5} label="Đang đọc project…" className="-mx-6" />;
  if (overview.rows.length === 0) {
    return <p className="text-muted-foreground">Chưa có project nào. Bấm “Tạo project mới…” để viết project.yaml.</p>;
  }
  return (
    <div className="-mx-6">
      <Table className="taiga-projects-table">
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Taiga</TableHead>
            <TableHead>Trong repo</TableHead>
            <TableHead>
              <span className="sr-only">Thao tác</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {overview.rows.map((row) => (
            <TableRow key={row.slug} data-slug={row.slug} data-state={row.slug === selected ? 'selected' : undefined} className={cn(row.slug === selected && 'selected')}>
              <TableCell className="max-w-64 truncate" title={row.name ?? undefined}>
                {row.name ?? '—'}
              </TableCell>
              <TableCell>
                <Code>{row.slug}</Code>
              </TableCell>
              <TableCell>{row.taiga ? `#${row.taiga.id} · ${row.taiga.admin ? 'admin' : 'thành viên'}` : 'Chưa có trên Taiga'}</TableCell>
              <TableCell>{rowState(row)}</TableCell>
              <TableCell className="text-right">
                <Button type="button" variant="outline" size="sm" data-open={row.slug} disabled={Boolean(busy)} onClick={() => onOpen(row.slug)}>
                  {busy === `open:${row.slug}` && <Spinner />}
                  {row.hasProjectYaml ? 'Mở' : 'Tạo project.yaml'}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function TaigaValues({ detail }: { detail: TaigaProjectDetail }) {
  const taiga = detail.taiga;
  if (!taiga) {
    return (
      <p className="text-muted-foreground" id="taiga-project-remote">
        {detail.taigaMessage ?? ''}
      </p>
    );
  }
  const values: [string, string[]][] = [
    ['Issue type', taiga.issueTypes],
    ['Severity', taiga.severities],
    ['Priority', taiga.priorities],
  ];
  return (
    <div id="taiga-project-remote" className="space-y-2">
      <p>
        Trên Taiga: #{taiga.project.id} {taiga.project.name} · bạn là {taiga.project.admin ? 'admin' : 'thành viên (bootstrap cần quyền admin)'}
      </p>
      <Table className="taiga-values [--table-edge:0px]">
        <TableBody>
          {values.map(([label, names]) => (
            <TableRow key={label}>
              <TableHead scope="row" className="w-32">
                {label}
              </TableHead>
              <TableCell className="whitespace-normal break-words">{names.length ? names.join(', ') : '(không có)'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ProjectForm({
  form,
  busy,
  nameRef,
  onChange,
  onSave,
  onReload,
}: {
  form: FormState;
  busy: Busy;
  nameRef: RefObject<HTMLInputElement | null>;
  onChange(settings: ProjectSettings): void;
  onSave(rebase: boolean): void;
  onReload(): void;
}) {
  const { settings } = form;
  const set = (patch: Partial<ProjectSettings>) => onChange({ ...settings, ...patch });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(false);
  };
  return (
    <form id="project-form" className="project-form flex flex-col gap-4" onSubmit={submit}>
      <h4 className="font-medium">{form.baseDigest === null ? 'Tạo project.yaml' : 'project.yaml'}</h4>
      <Field>
        <FieldLabel htmlFor="pf-name">
          Tên project (<Code>{'<Khách hàng/Mảng> - <Sản phẩm>'}</Code>)
        </FieldLabel>
        <Input
          id="pf-name"
          ref={nameRef}
          type="text"
          required
          value={settings.name}
          placeholder="Vigo - Core Mapping"
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldDescription>
          Slug: <Code className="">
            <span id="pf-slug">{slugHint(form)}</span>
          </Code>
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="pf-description">Mô tả</FieldLabel>
        <Textarea id="pf-description" rows={3} value={settings.description} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <div className="flex flex-wrap items-end gap-6">
        <Field className="w-fit">
          <FieldLabel htmlFor="pf-template">Template</FieldLabel>
          <NativeSelect id="pf-template" value={settings.template} onChange={(event) => set({ template: event.target.value })}>
            {PROJECT_TEMPLATES.map((template) => (
              <NativeSelectOption key={template} value={template}>
                {template}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex h-9 items-center gap-2">
          <Checkbox id="pf-private" checked={settings.isPrivate} onCheckedChange={(checked) => set({ isPrivate: checked === true })} />
          <Label htmlFor="pf-private">Project riêng tư</Label>
        </div>
      </div>
      <FieldSet>
        <FieldLegend variant="label">Module bật</FieldLegend>
        <div className="flex flex-wrap gap-4">
          {PROJECT_MODULES.map((module) => (
            <div key={module} className="flex items-center gap-2">
              <Checkbox
                id={`pf-module-${module}`}
                name="pf-module"
                value={module}
                checked={settings.modules.includes(module)}
                onCheckedChange={(checked) =>
                  set({ modules: checked === true ? PROJECT_MODULES.filter((m) => m === module || settings.modules.includes(m)) : settings.modules.filter((m) => m !== module) })
                }
              />
              <Label htmlFor={`pf-module-${module}`} className="font-normal">
                {module}
                {REQUIRED_MODULES.includes(module) ? ' (bắt buộc)' : ''}
              </Label>
            </div>
          ))}
        </div>
      </FieldSet>
      {form.issues.length > 0 && (
        <ul id="pf-issues" className="issues list-disc space-y-1 pl-4 text-destructive">
          {form.issues.map((issue, index) => (
            <li key={index}>
              <Code>{issue.path || '(file)'}</Code> {issue.message} <span className="text-muted-foreground">[{issue.rule}]</span>
            </li>
          ))}
        </ul>
      )}
      {form.conflict && (
        <Alert variant="destructive" id="pf-conflict" className="failure">
          <AlertDescription className="gap-3">
            <p className="error">project.yaml đã đổi từ lúc bạn mở form (có thể agent vừa sửa). Chưa ghi gì.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={onReload}>
                Bỏ thay đổi của tôi, tải lại file
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => onSave(true)}>
                Ghi phần của tôi lên bản mới
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-muted-foreground">Form chỉ sửa các trường trên; tag, custom attribute, member và wiki_home trong project.yaml được giữ nguyên.</p>
      <div className="flex justify-end">
        <Button type="submit" id="pf-save" disabled={Boolean(busy)}>
          {busy === 'save' && <Spinner />}
          Lưu project.yaml
        </Button>
      </div>
    </form>
  );
}

export function ProjectsCard() {
  const section = useApp((s) => s.section);
  const repo = useApp((s) => s.repo);
  const [overview, setOverview] = useState<TaigaProjectsOverview>();
  const [listFailure, setListFailure] = useState<Failure>();
  const [detail, setDetail] = useState<TaigaProjectDetail>();
  const [detailFailure, setDetailFailure] = useState<Failure>();
  const [form, setForm] = useState<FormState>();
  const [bootstrap, setBootstrap] = useState<ReactNode>();
  const [busy, setBusy] = useState<Busy>();
  /** The repository the list was read for; a list read for another one is dropped. */
  const loadedFor = useRef<string | undefined>(undefined);
  const detailRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  /** Set by opening a project or a new form: scroll the detail into view (and focus the name for a new project). */
  const [reveal, setReveal] = useState<{ focusName: boolean }>();

  useEffect(() => {
    if (!reveal) return;
    detailRef.current?.scrollIntoView({ block: 'start' });
    if (reveal.focusName) nameRef.current?.focus();
  }, [reveal]);

  async function loadList(): Promise<void> {
    const root = useApp.getState().repo?.root;
    loadedFor.current = root;
    setOverview(undefined);
    setListFailure(undefined);
    if (!root) return;
    setBusy('list');
    const result = await api.listTaigaProjects().finally(() => setBusy(undefined));
    if (loadedFor.current !== root) return;
    if (!result.ok) return setListFailure(result);
    setOverview(result.value);
  }

  async function openDetail(slug: string): Promise<void> {
    setBusy(`open:${slug}`);
    const result = await api.readTaigaProject(slug).finally(() => setBusy(undefined));
    if (!result.ok) return setDetailFailure(result);
    setDetailFailure(undefined);
    setDetail(result.value);
    setForm(formFor(result.value));
    setBootstrap(undefined);
    setReveal({ focusName: false });
  }

  function newProject(): void {
    setDetail(undefined);
    setDetailFailure(undefined);
    setForm({ slug: undefined, baseDigest: null, settings: NEW_PROJECT, issues: [], dirty: false, conflict: false });
    setBootstrap(undefined);
    setReveal({ focusName: true });
  }

  useEffect(() => {
    if (section !== 'taiga' || repo?.root === loadedFor.current) return;
    setDetail(undefined);
    setDetailFailure(undefined);
    setForm(undefined);
    setBootstrap(undefined);
    void loadList();
  }, [section, repo]);

  /** Re-reads project.yaml into the form, dropping unsaved edits. */
  async function reloadForm(): Promise<void> {
    if (form?.slug === undefined) return newProject();
    await openDetail(form.slug);
  }

  /** Saves the form; `rebase` writes it over the current file after a conflict. */
  async function saveForm(rebase: boolean): Promise<void> {
    if (!form) return;
    const settings = { ...form.settings, name: form.settings.name.trim() };
    let baseDigest = form.baseDigest;
    if (rebase) {
      const current = await api.readTaigaProject(form.slug ?? projectSlug(settings.name));
      if (!current.ok) return toast(current.message, 'error');
      baseDigest = current.value.file.digest;
    }
    setBusy('save');
    const result = await api
      .saveProjectSettings({ ...(form.slug !== undefined && { slug: form.slug }), settings, baseDigest })
      .finally(() => setBusy(undefined));
    if (!result.ok) return toast(result.message, 'error');
    const outcome = result.value;
    if (outcome.status === 'conflict') return setForm((current) => current && { ...current, conflict: true });
    if (outcome.status === 'invalid') return setForm((current) => current && { ...current, issues: outcome.issues, conflict: false });
    toast(`Đã lưu ${outcome.slug}/project.yaml.`);
    await loadList();
    await openDetail(outcome.slug);
  }

  async function runBootstrap(): Promise<void> {
    if (!detail) return;
    const slug = detail.slug;
    setBootstrap(<p className="text-muted-foreground muted">Đang chạy taigent bootstrap --dry-run…</p>);
    setBusy('bootstrap');
    const result = await api.bootstrapProject(slug).finally(() => setBusy(undefined));
    if (!result.ok) return setBootstrap(<FailureBlock failure={result} />);
    const outcome = result.value;
    if (outcome.status === 'cancelled') toast('Đã huỷ, chưa ghi gì lên Taiga.');
    if (outcome.status === 'bootstrapped') {
      toast('Đã bootstrap project trên Taiga.');
      // The project (now) on Taiga: its list row and its issue values.
      await loadList();
      await openDetail(slug);
    }
    setBootstrap(bootstrapResult(outcome));
  }

  async function openBacklog(slug: string): Promise<void> {
    // A project.yaml or backlog.yaml written since the repository was read: list it in the picker first.
    await refreshRepo();
    await openProject(slug);
    showSection('backlog');
  }

  const status = !repo
    ? 'Mở một thư mục repo để xem project.'
    : listFailure
      ? ''
      : !overview
        ? 'Đang đọc project…'
        : (overview.taigaMessage ?? `${overview.rows.filter((row) => row.taiga).length} project trên Taiga mà bạn là thành viên.`);
  const bootstrapOff = !detail || detail.file.digest === null || Boolean(form?.dirty);
  const title = detail ? (detail.taiga?.project.name ?? form?.settings.name) || detail.slug : 'Project mới';

  return (
    <Card id="taiga-project" className="taiga-project">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="mr-auto">
          <h2>Project</h2>
        </CardTitle>
        <Button id="taiga-projects-refresh" type="button" variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void loadList()}>
          {busy === 'list' && <Spinner />}
          Làm mới
        </Button>
        <Button id="taiga-project-new" type="button" variant="outline" size="sm" disabled={Boolean(busy)} onClick={newProject}>
          Tạo project mới…
        </Button>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <p id="taiga-projects-status" className="text-muted-foreground" aria-live="polite">
          {status}
        </p>
        <div id="taiga-projects-list" className="min-w-0">
          <ProjectList
            overview={overview}
            failure={listFailure}
            hasRepo={Boolean(repo)}
            selected={form?.slug ?? detail?.slug}
            busy={busy}
            onOpen={(slug) => void openDetail(slug)}
          />
        </div>
        <div id="taiga-project-detail" ref={detailRef} className="min-w-0 scroll-mt-6">
          {detailFailure ? (
            <FailureBlock failure={detailFailure} />
          ) : (
            form && (
              <div className="taiga-project-card flex flex-col gap-4 rounded-lg border p-4">
                <h3 className="flex flex-wrap items-center gap-2 text-lg font-medium">
                  {title}
                  {detail && <Code className="slug">{detail.slug}</Code>}
                </h3>
                {detail && <TaigaValues detail={detail} />}
                {detail?.hasBacklog && (
                  <div>
                    <Button type="button" variant="outline" size="sm" id="taiga-open-backlog" disabled={Boolean(busy)} onClick={() => void openBacklog(detail.slug)}>
                      Mở backlog
                    </Button>
                  </div>
                )}
                <Separator />
                <ProjectForm
                  form={form}
                  busy={busy}
                  nameRef={nameRef}
                  onChange={(settings) => setForm({ ...form, settings, dirty: true })}
                  onSave={(rebase) => void saveForm(rebase)}
                  onReload={() => void reloadForm()}
                />
                {detail && (
                  <>
                    <Separator />
                    <div className="bootstrap-block flex flex-col items-start gap-2">
                      <h4 className="font-medium">Bootstrap</h4>
                      <p className="text-muted-foreground">
                        Tạo project trên Taiga theo project.yaml, hoặc bổ sung phần còn thiếu (module, tag, custom attribute, member, wiki home). Ứng
                        dụng chạy bootstrap --dry-run, hỏi xác nhận, rồi mới chạy --yes. Không bao giờ tắt, đổi tên hay xoá gì.
                      </p>
                      <Button
                        type="button"
                        id="taiga-bootstrap"
                        data-off={String(bootstrapOff)}
                        disabled={Boolean(busy) || bootstrapOff}
                        title={bootstrapOff ? 'Lưu project.yaml trước khi bootstrap.' : ''}
                        onClick={() => void runBootstrap()}
                      >
                        {busy === 'bootstrap' && <Spinner />}
                        Bootstrap lên Taiga…
                      </Button>
                      <div id="taiga-bootstrap-result" className="w-full min-w-0" aria-live="polite">
                        {bootstrap}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// The Wiki section: the pages of docs.yaml, the page form (slug + Markdown with a live preview, through the manifest
// edit API via `api`) and "Đẩy wiki lên Taiga" (dry run, native confirm dialog in main, then upload).
// Wiki pages are not reviewed: no verdicts, no review.yaml. The list follows the open project and live changes.

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Failure,
  ManifestFile,
  ManifestIssue,
  SaveWikiPageRequest,
  UploadOperation,
  UploadPlan,
  WikiPageFile,
  WikiSnapshot,
  WikiUploadOutcome,
} from '../../../shared/api.ts';
import { toast } from '@/actions.ts';
import { Code, PageHeader, ScreenBody, TableSkeleton, TONE_CLASS } from '@/components/common.tsx';
import { showConflict } from '@/components/conflict-dialog.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Markdown } from '@/components/markdown.tsx';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Empty, EmptyDescription } from '@/components/ui/empty.tsx';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { api, useApp } from '@/store.ts';

interface OpenPage {
  slug: string;
  /** The page being edited; absent for a new page. */
  page?: WikiPageFile;
  /** docs.yaml as the form opened it: its digest guards the save. */
  docs: ManifestFile;
}

/** docs.yaml and its pages for project `slug` as last read, or why reading them failed. */
type Loaded = { slug: string; wiki: WikiSnapshot } | { slug: string; failure: Failure };

export function WikiScreen() {
  const slug = useApp((state) => state.view?.slug);
  const section = useApp((state) => state.section);
  const [loaded, setLoaded] = useState<Loaded>();
  const [result, setResult] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ key: number; open: OpenPage }>();
  const [formOpen, setFormOpen] = useState(false);

  async function load(): Promise<void> {
    const current = useApp.getState().view?.slug;
    if (!current) return;
    const read = await api.readWiki(current);
    if (useApp.getState().view?.slug !== current) return;
    if (!read.ok) {
      setLoaded({ slug: current, failure: read });
      return void toast(read.message, 'error');
    }
    setLoaded({ slug: current, wiki: read.value });
  }

  // Another project (or none): forget its pages and the last upload result.
  useEffect(() => {
    setLoaded(undefined);
    setResult(null);
  }, [slug]);

  // Read again when the screen shows and when the open project changes while it shows.
  useEffect(() => {
    if (slug && section === 'wiki') void load();
  }, [slug, section]);

  // Live changes (an agent edited docs.yaml or a page): read again while the screen shows.
  useEffect(
    () =>
      api.onProjectChanged(() => {
        if (useApp.getState().section === 'wiki') void load();
      }),
    [],
  );

  /** Opens the form on page `pageSlug` (read again, for fresh digests), or on a new page. */
  async function openPage(pageSlug?: string): Promise<void> {
    const current = useApp.getState().view?.slug;
    if (!current) return void toast('Chọn dự án trước.', 'error');
    const read = await api.readWiki(current);
    if (!read.ok) return void toast(read.message, 'error');
    setLoaded({ slug: current, wiki: read.value });
    const page = pageSlug === undefined ? undefined : read.value.pages.find((candidate) => candidate.slug === pageSlug);
    if (pageSlug !== undefined && !page) return void toast(`Không còn trang ${pageSlug} trong docs.yaml (agent vừa đổi?).`, 'error');
    setForm((previous) => ({ key: (previous?.key ?? 0) + 1, open: { slug: current, docs: read.value.docs, ...(page && { page }) } }));
    setFormOpen(true);
  }

  function saved(open: OpenPage, pageSlug: string, file: string, wiki: WikiSnapshot | undefined): void {
    setFormOpen(false);
    if (wiki) setLoaded({ slug: open.slug, wiki });
    toast(`Đã lưu trang ${pageSlug} (${file}).`);
  }

  function showUpload(uploadSlug: string, title: string, content: ReactNode): void {
    setResult(
      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">{title}</h2>
          <CardDescription>
            Dự án {uploadSlug} · {new Date().toLocaleTimeString('vi-VN')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">{content}</CardContent>
      </Card>,
    );
  }

  function uploadOutcome(uploadSlug: string, outcome: WikiUploadOutcome): void {
    if (outcome.status === 'cancelled') {
      toast('Đã huỷ, chưa ghi gì lên Taiga.');
      const { plan } = outcome;
      return showUpload(
        uploadSlug,
        'Đã huỷ đẩy wiki',
        <>
          <p>Chưa ghi gì lên Taiga.</p>
          <PlanSummary plan={plan} />
          <OperationsTable rows={plan.operations.map((operation) => ({ operation, label: ACTION_LABEL[operation.action] }))} />
        </>,
      );
    }
    if (outcome.status === 'no-changes') return showUpload(uploadSlug, 'Wiki trên Taiga đã khớp với docs.yaml', <p>Không có gì cần đẩy.</p>);
    const { report } = outcome;
    showUpload(
      uploadSlug,
      'Đã đẩy wiki lên Taiga',
      <>
        <p>
          Đã tạo {report.summary.created} · Đã cập nhật {report.summary.updated} · Không đổi {report.summary.unchanged}
        </p>
        <OperationsTable rows={report.operations.map((operation) => ({ operation, label: RESULT_LABEL[operation.result] ?? operation.result }))} />
      </>,
    );
  }

  async function upload(): Promise<void> {
    const current = useApp.getState().view?.slug;
    if (!current || busy) return;
    setBusy(true);
    setResult(
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">Đang chạy taigent upload --dry-run…</p>
        <div className="rounded-lg bg-card py-4 shadow-elevation-card">
          <TableSkeleton rows={3} label="Đang chạy taigent upload --dry-run…" />
        </div>
      </div>,
    );
    try {
      const outcome = await api.uploadWiki(current);
      if (!outcome.ok) return showUpload(current, 'Chưa đẩy được wiki lên Taiga', <FailureBlock failure={outcome} />);
      uploadOutcome(current, outcome.value);
    } finally {
      setBusy(false);
    }
  }

  const shown = loaded && loaded.slug === slug ? loaded : undefined;
  return (
    <ScreenBody>
      <PageHeader
        title="Wiki"
        description={
          <>
            Các trang wiki khai báo trong <Code>taiga/&lt;slug&gt;/docs.yaml</Code>; trang mới được lưu ở{' '}
            <Code>taiga/&lt;slug&gt;/pages/&lt;slug trang&gt;.md</Code>. Wiki không qua review: "Đẩy wiki lên Taiga" cho xem trước những gì sẽ tạo,
            cập nhật và bỏ qua, rồi chỉ ghi khi bạn xác nhận.
          </>
        }
        actions={
          <>
            <Button id="wiki-add" variant="outline" disabled={!slug || busy} onClick={() => void openPage()}>
              + Trang wiki
            </Button>
            <Button id="wiki-upload" disabled={!slug || busy} onClick={() => void upload()}>
              {busy && <Spinner />}
              Đẩy wiki lên Taiga
            </Button>
          </>
        }
      />
      <div id="wiki-pages" className="wiki-pages">
        {!slug ? (
          <EmptyState>Mở thư mục repo và chọn dự án để xem wiki.</EmptyState>
        ) : !shown ? (
          <div role="status" aria-label="Đang đọc wiki…" className="flex flex-col gap-2">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-14 w-full rounded-lg" />
            ))}
          </div>
        ) : 'failure' in shown ? (
          <FailureBlock failure={shown.failure} />
        ) : shown.wiki.pages.length === 0 ? (
          <EmptyState>Chưa có trang wiki nào trong docs.yaml. Bấm "+ Trang wiki" để tạo trang đầu tiên.</EmptyState>
        ) : (
          <ItemGroup className="gap-2">
            {shown.wiki.pages.map((page) => {
              const title = /^#\s+(.+)$/m.exec(page.page.text)?.[1]?.trim();
              return (
                <Item key={page.slug} role="listitem" variant="outline" size="sm" className="wiki-page bg-card" data-slug={page.slug}>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="min-w-0">
                      <span className="">{page.slug}</span>
                      {title && <span className="truncate font-normal text-muted-foreground" title={title}>· {title}</span>}
                    </ItemTitle>
                    <ItemDescription className="truncate" title={page.file}>
                      <Code>{page.file}</Code>
                      {page.page.text === '' ? ' (trống hoặc chưa có file)' : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="outline" size="sm" data-action="edit" aria-label={`Sửa trang ${page.slug}`} onClick={() => void openPage(page.slug)}>
                      Sửa
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </div>
      <div id="wiki-result" className="changes-result" aria-live="polite">
        {result}
      </div>
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        {form && <WikiPageForm key={form.key} initial={form.open} active={formOpen} onCancel={() => setFormOpen(false)} onSaved={saved} />}
      </Dialog>
    </ScreenBody>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <Empty className="empty-state border">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

// ---- page form ------------------------------------------------------------------------------------------------

interface Issues {
  /** Slug issues (`wiki[1].slug`), next to the slug field. */
  slug: ManifestIssue[];
  /** The other issues, in the list under the form. */
  general: ManifestIssue[];
  extra?: ReactNode;
}

const NO_ISSUES: Issues = { slug: [], general: [] };

function splitIssues(issues: ManifestIssue[], extra?: ReactNode): Issues {
  const onSlug = issues.filter((issue) => /^wiki\[\d+\]\.slug$/.test(issue.path));
  return { slug: onSlug, general: issues.filter((issue) => !onSlug.includes(issue)), ...(extra !== undefined && { extra }) };
}

function WikiPageForm({
  initial,
  active,
  onCancel,
  onSaved,
}: {
  initial: OpenPage;
  /** The dialog is open: only then does the form watch for changes under it. */
  active: boolean;
  onCancel: () => void;
  onSaved: (open: OpenPage, pageSlug: string, file: string, wiki: WikiSnapshot | undefined) => void;
}) {
  // Mutable on purpose: "Áp lại" moves the form onto the current file without re-rendering anything.
  const openRef = useRef<OpenPage>({ ...initial });
  const { page } = initial;
  const [pageSlug, setPageSlug] = useState(page?.slug ?? '');
  const [content, setContent] = useState(page?.page.text.replace(/\r\n/g, '\n') ?? '');
  const [stale, setStale] = useState(false);
  const [issues, setIssues] = useState<Issues>(NO_ISSUES);
  const [saving, setSaving] = useState(false);
  const slugRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  // When docs.yaml or the open page's file changes under the form (an agent edited it), the form says so.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const unsubscribe = api.onProjectChanged(async () => {
      const open = openRef.current;
      const latest = await api.readWiki(open.slug);
      if (!alive || !latest.ok) return;
      const current = open.page && latest.value.pages.find((candidate) => candidate.slug === open.page!.slug);
      setStale(!(latest.value.docs.digest === open.docs.digest && (!open.page || current?.page.digest === open.page.page.digest)));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [active]);

  /** Sends one save; a conflict opens the conflict dialog, whose "Áp lại" sends it again on the current file. */
  async function save(request: SaveWikiPageRequest): Promise<void> {
    const open = openRef.current;
    setSaving(true);
    const result = await api.saveWikiPage(open.slug, request).finally(() => setSaving(false));
    if (!result.ok) return setIssues(splitIssues([], <FailureBlock failure={result} />));
    const outcome = result.value;
    if (outcome.status === 'invalid') return setIssues(splitIssues(outcome.issues));
    if (outcome.status === 'conflict') {
      const { current } = outcome;
      if (current.file === open.docs.file) {
        return showConflict(
          open.docs,
          current,
          () => {
            open.docs = current;
            setStale(false);
            void save({ ...request, baseDigest: current.digest });
          },
          'docs.yaml',
        );
      }
      if (!open.page) {
        // A new page whose file already exists without a docs.yaml entry: never written over.
        return setIssues(
          splitIssues([], <span>File {current.file} đã có sẵn nhưng không có trong docs.yaml. Chọn slug khác, hoặc nhờ agent thêm entry cho file đó.</span>),
        );
      }
      const openPage = open.page;
      return showConflict(
        openPage.page,
        current,
        () => {
          openPage.page = current;
          setStale(false);
          void save({ ...request, pageDigest: current.digest });
        },
        openPage.file,
      );
    }
    onSaved(open, request.page.slug, outcome.page.file, outcome.wiki.ok ? outcome.wiki.value : undefined);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const open = openRef.current;
    void save({
      baseDigest: open.docs.digest,
      ...(open.page && { pageDigest: open.page.page.digest }),
      page: { slug: pageSlug.trim(), content },
    });
  }

  const slugError = issues.slug.map((issue) => `${issue.message} [${issue.rule}]`).join(' ');
  return (
    <DialogContent
      id="wiki-form"
      className="item-form wiki-form max-h-[90vh] overflow-y-auto sm:max-w-5xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        (page ? contentRef : slugRef).current?.focus();
      }}
    >
      <form id="wiki-form-body" className="flex min-w-0 flex-col gap-4" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{page ? `Sửa trang wiki ${page.slug}` : 'Thêm trang wiki'}</DialogTitle>
          <DialogDescription>Wiki không qua review. Lưu xong, dùng "Đẩy wiki lên Taiga" để ghi lên Taiga.</DialogDescription>
        </DialogHeader>
        {stale && (
          <Alert id="wiki-stale" className={TONE_CLASS.changes}>
            <AlertDescription className="text-warning">
              docs.yaml hoặc file của trang vừa đổi từ lúc mở form (có thể do agent). Khi lưu, bạn sẽ được xem thay đổi đó rồi áp lại phần của mình.
            </AlertDescription>
          </Alert>
        )}
        <Field className="field" data-field="slug" data-invalid={slugError ? true : undefined}>
          <FieldLabel htmlFor="wiki-slug">Slug</FieldLabel>
          <Input
            ref={slugRef}
            id="wiki-slug"
            className=""
            autoComplete="off"
            spellCheck={false}
            disabled={page !== undefined}
            placeholder="spec-auth-login"
            aria-invalid={slugError ? true : undefined}
            value={pageSlug}
            onChange={(event) => setPageSlug(event.target.value)}
          />
          <FieldDescription>
            {page
              ? `File: ${page.file}. Slug không đổi được: trang có thể đã có trên Taiga, đổi slug sẽ tạo trang mới.`
              : 'Chữ thường, số và dấu gạch ngang, ví dụ spec-auth-login. Trang được lưu ở pages/<slug>.md.'}
          </FieldDescription>
          <FieldError className="field-error">{slugError}</FieldError>
        </Field>
        <Field className="field" data-field="content">
          <FieldLabel htmlFor="wiki-content">Nội dung (Markdown)</FieldLabel>
          <div className="wiki-editor grid min-w-0 gap-3 md:grid-cols-2">
            <Textarea
              ref={contentRef}
              id="wiki-content"
              rows={18}
              spellCheck={false}
              className="h-96 resize-none field-sizing-fixed"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            <Markdown
              id="wiki-preview"
              text={content}
              empty={null}
              className="wiki-preview h-96 min-w-0 overflow-auto rounded-md border bg-card p-3 break-words"
            />
          </div>
        </Field>
        {(issues.general.length > 0 || issues.extra !== undefined) && (
          <ul id="wiki-issues" className="issues list-disc space-y-1 pl-4 text-destructive">
            {issues.general.map((issue, index) => (
              <li key={index}>
                {issue.path && <Code>{issue.path}</Code>} {issue.message} <span className="text-muted-foreground">[{issue.rule}]</span>
              </li>
            ))}
            {issues.extra !== undefined && <li className="list-none">{issues.extra}</li>}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" id="wiki-cancel" onClick={onCancel}>
            Huỷ
          </Button>
          <Button type="submit" id="wiki-save" disabled={saving}>
            {saving && <Spinner />}
            Lưu trang
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ---- upload ---------------------------------------------------------------------------------------------------

const ACTION_LABEL: Record<UploadOperation['action'], string> = { create: 'Tạo mới', update: 'Cập nhật', skip: 'Bỏ qua' };
const RESULT_LABEL: Record<string, string> = { created: 'Đã tạo', updated: 'Đã cập nhật', unchanged: 'Không đổi' };

function PlanSummary({ plan }: { plan: UploadPlan }) {
  return (
    <p>
      Tạo mới {plan.summary.create} · Cập nhật {plan.summary.update} · Bỏ qua {plan.summary.skip}
    </p>
  );
}

function OperationsTable({ rows }: { rows: { operation: UploadOperation; label: string }[] }) {
  return (
    <div className="-mx-6 max-h-96 overflow-auto">
      <Table className="plan">
        <TableHeader>
          <TableRow>
            <TableHead>Thao tác</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Mục</TableHead>
            <TableHead>File</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ operation, label }, index) => (
            <TableRow key={index} className={`op-${operation.action}`}>
              <TableCell>{label}</TableCell>
              <TableCell>{operation.type === 'wiki' ? 'Trang wiki' : 'Tệp đính kèm'}</TableCell>
              <TableCell>
                {operation.type === 'wiki' ? (
                  <Code>{operation.slug}</Code>
                ) : (
                  <>
                    <Code>{operation.name}</Code> → {operation.target}
                  </>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{operation.file}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

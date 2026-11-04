// The Thay đổi section: an overview of the open project (what a push would carry and its review state), `taigent plan`
// (read-only) and the push to Taiga after the user confirms. Items on Taiga no longer in the backlog, and stale epic
// links, are only reported: taigent never deletes or unlinks them. The result belongs to the project that was open:
// it is forgotten when another repository or project opens.

import { type ReactNode, useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ApplyOutcome, Plan, PreviewItem } from '../../../shared/api.ts';
import { withBusy, toast } from '@/actions.ts';
import { Code, PageHeader, ScreenBody, StatCell, StatusBadge, TYPE_LABEL } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent } from '@/components/ui/card.tsx';
import { Empty, EmptyDescription } from '@/components/ui/empty.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { api, useApp, visibleNodes } from '@/store.ts';

/** What the result region shows: nothing, a note while a run goes, or the outcome of a run for project `slug`. */
type ChangesResult = { note?: string } | { slug: string; title: string; time: string; content: ReactNode };

const ACTION: Record<string, string> = { create: 'Tạo mới', update: 'Cập nhật', link: 'Gắn vào epic' };
const RESULT: Record<string, string> = { created: 'Đã tạo', updated: 'Đã cập nhật', linked: 'Đã gắn', unchanged: 'Không đổi' };

const typeLabel = (type: string) => TYPE_LABEL[type as PreviewItem['type']] ?? type;

function Overview() {
  const view = useApp((s) => s.view);
  if (!view) {
    return (
      <Empty id="changes-overview" className="changes-overview border">
        <EmptyDescription>Mở thư mục repo và chọn dự án để xem thay đổi.</EmptyDescription>
      </Empty>
    );
  }
  const s = view.preview.summary;
  const sep = <Separator orientation="vertical" className="sep h-8" />;
  return (
    <Card id="changes-overview" className="changes-overview">
      <CardContent className="flex flex-wrap items-center gap-6">
        <div className="overview-project">
          <StatCell label="Dự án đang mở" value={view.slug} />
        </div>
        {sep}
        <StatCell label="Epic" value={s.epics} />
        <StatCell label="Story" value={s.stories} />
        <StatCell label="Task" value={s.tasks} />
        <StatCell label="Issue" value={s.issues} />
        {sep}
        <StatCell label="Mới" value={s.new} tone="new" />
        <StatCell label="Đã đẩy" value={s.applied} tone="applied" />
        {sep}
        <StatCell label="Đạt" value={s.approved} tone="approved" />
        <StatCell label="Cần sửa" value={s.changes} tone="changes" />
        <StatCell label="Chưa duyệt" value={s.unreviewed} tone="unreviewed" />
        <StatCell label="Đã đổi sau khi duyệt" value={s.stale} tone="stale" />
        <StatCell label="Góp ý mở" value={s.openComments} tone={s.openComments > 0 ? 'comments' : undefined} />
        <div className="ml-auto">
          {view.validation.valid ? (
            <StatusBadge tone="approved" className="validity ok">
              Manifest hợp lệ
            </StatusBadge>
          ) : (
            <StatusBadge tone="stale" className="validity bad">
              Manifest lỗi
            </StatusBadge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WarnBox({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <Alert id={id} className="warn-box border-warning/30 bg-warning/10">
      <TriangleAlert aria-hidden className="text-warning" />
      <AlertTitle className="line-clamp-none whitespace-normal">{title}</AlertTitle>
      <AlertDescription className="text-foreground">{children}</AlertDescription>
    </Alert>
  );
}

/** What `taigent plan` would write, the Taiga items no longer in the backlog, and the stale epic links. */
function PlanTable({ plan, subjects }: { plan: Plan; subjects: Map<string, string> }) {
  const operations = plan.operations.filter((operation) => operation.action !== 'skip');
  return (
    <div className="flex flex-col gap-3">
      <p>
        Tạo mới {plan.summary.create} · Cập nhật {plan.summary.update} · Gắn epic {plan.summary.link} · Không đổi {plan.summary.skip}
      </p>
      {operations.length === 0 && <p>Không có thay đổi nào cần đẩy.</p>}
      {operations.length > 0 && (
        <Table className="plan">
          <TableHeader>
            <TableRow>
              <TableHead>Thao tác</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead>Mục</TableHead>
              <TableHead>Chi tiết</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {operations.map((operation, index) => (
              <TableRow key={`${operation.action}-${operation.key}-${index}`} className={`op-${operation.action}`}>
                <TableCell>{ACTION[operation.action] ?? operation.action}</TableCell>
                <TableCell>{typeLabel(operation.type)}</TableCell>
                <TableCell className="max-w-md truncate" title={operation.fields?.subject ?? subjects.get(operation.key)}>
                  <Code>{operation.key}</Code> {operation.fields?.subject ?? subjects.get(operation.key) ?? ''}
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">
                  {operation.action === 'update'
                    ? `Đổi: ${Object.keys(operation.changes ?? {}).join(', ')}${operation.ref ? ` (#${operation.ref})` : ''}`
                    : operation.action === 'link'
                      ? `→ ${operation.epic}`
                      : operation.parent
                        ? `thuộc ${operation.parent}`
                        : ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {plan.orphans.length > 0 && (
        <WarnBox title={`${plan.orphans.length} mục trên Taiga không còn trong backlog (taigent không xoá):`}>
          <ul className="list-disc space-y-1 pl-4">
            {plan.orphans.map((orphan) => (
              <li key={`${orphan.type}-${orphan.id}`}>{`${typeLabel(orphan.type)} #${orphan.ref} ${orphan.key} – ${orphan.subject}`}</li>
            ))}
          </ul>
        </WarnBox>
      )}
      {plan.staleLinks.length > 0 && (
        <WarnBox
          id="plan-stale-links"
          title={`${plan.staleLinks.length} liên kết cũ (stale link): story trên Taiga còn gắn với epic mà backlog không còn đặt nó vào.`}
        >
          <p>Apply không bao giờ gỡ liên kết này. Nếu không cần nữa, gỡ tay trên Taiga.</p>
          <ul className="list-disc space-y-1 pl-4">
            {plan.staleLinks.map((link) => (
              <li key={`${link.ref}-${link.epicRef}`}>
                {'Story #'}
                {link.ref} <Code>{link.key}</Code>
                {' → epic #'}
                {link.epicRef} <Code>{link.epic}</Code>
              </li>
            ))}
          </ul>
        </WarnBox>
      )}
    </div>
  );
}

function ApplyContent({ outcome }: { outcome: Exclude<ApplyOutcome, { status: 'cancelled' | 'no-changes' }> }) {
  if (outcome.status === 'blocked') {
    return (
      <>
        <ul className="issues list-disc space-y-1 pl-4">
          {outcome.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
        <p className="text-muted-foreground">Nhờ agent xử lý góp ý (skill taiga-plan-backlog), rồi duyệt lại trong mục Backlog.</p>
      </>
    );
  }
  const { report } = outcome;
  return (
    <>
      <p>
        Tạo {report.summary.created} · Cập nhật {report.summary.updated} · Gắn epic {report.summary.linked} · Không đổi {report.summary.unchanged}
      </p>
      <Table className="plan">
        <TableHeader>
          <TableRow>
            <TableHead>Kết quả</TableHead>
            <TableHead>Loại</TableHead>
            <TableHead>Mục</TableHead>
            <TableHead>Ref</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.operations
            .filter((operation) => operation.result !== 'unchanged')
            .map((operation, index) => (
              <TableRow key={`${operation.key}-${index}`}>
                <TableCell>{RESULT[operation.result] ?? operation.result}</TableCell>
                <TableCell>{typeLabel(operation.type)}</TableCell>
                <TableCell>
                  <Code>{operation.key}</Code>
                </TableCell>
                <TableCell>#{operation.ref}</TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </>
  );
}

export function ChangesScreen() {
  const view = useApp((s) => s.view);
  const busy = useApp((s) => s.busy);
  const root = useApp((s) => s.repo?.root);
  const [result, setResult] = useState<ChangesResult>({});
  const [running, setRunning] = useState<'plan' | 'apply'>();

  // The result belongs to the repository and project that were open: forget it when either changes.
  const slug = view?.slug;
  useEffect(() => setResult({}), [root, slug]);

  const show = (slug: string, title: string, content: ReactNode) =>
    setResult({ slug, title, time: new Date().toLocaleTimeString('vi-VN'), content });

  const run = async (which: 'plan' | 'apply', note: string, fn: (slug: string) => Promise<void>) => {
    const open = useApp.getState().view;
    if (!open) return;
    setResult({ note });
    setRunning(which);
    try {
      await withBusy(() => fn(open.slug));
    } finally {
      setRunning(undefined);
    }
  };

  const showPlan = () =>
    run('plan', 'Đang chạy taigent plan…', async (slug) => {
      const planned = await api.plan(slug);
      if (!planned.ok) return show(slug, 'Xem thay đổi trên Taiga', <FailureBlock failure={planned} />);
      const open = useApp.getState().view;
      const subjects = new Map(open ? visibleNodes(open, 'all').map((node) => [node.item.key, node.item.subject]) : []);
      show(slug, planned.value.changes ? 'Thay đổi sẽ ghi lên Taiga' : 'Taiga đã khớp với backlog', <PlanTable plan={planned.value} subjects={subjects} />);
    });

  const pushToTaiga = () =>
    run('apply', 'Đang kiểm tra trước khi đẩy…', async (slug) => {
      const applied = await api.apply(slug);
      if (!applied.ok) return show(slug, 'Đẩy lên Taiga', <FailureBlock failure={applied} />);
      const outcome = applied.value;
      if (outcome.status === 'cancelled') {
        toast('Đã huỷ, chưa ghi gì lên Taiga.');
        return show(slug, 'Đã huỷ đẩy lên Taiga', <p>Chưa ghi gì lên Taiga.</p>);
      }
      if (outcome.status === 'no-changes') return show(slug, 'Taiga đã khớp với backlog', <p>Không có thay đổi nào cần đẩy.</p>);
      show(slug, outcome.status === 'blocked' ? 'Chưa thể đẩy lên Taiga' : 'Đã đẩy lên Taiga', <ApplyContent outcome={outcome} />);
    });

  const off = !view || busy;
  return (
    <ScreenBody>
      <PageHeader
        title="Thay đổi trên Taiga"
        description="So sánh backlog của dự án đang mở với Taiga (chỉ đọc), rồi đẩy lên sau khi bạn xác nhận. Các mục trên Taiga không còn trong backlog chỉ được báo, taigent không bao giờ xoá chúng."
        actions={
          <>
            <Button id="plan-btn" variant="outline" disabled={off} onClick={() => void showPlan()}>
              {running === 'plan' && <Spinner />}
              Xem thay đổi trên Taiga
            </Button>
            <Button id="apply-btn" disabled={off} onClick={() => void pushToTaiga()}>
              {running === 'apply' && <Spinner />}
              Đẩy lên Taiga
            </Button>
          </>
        }
      />
      <Overview />
      <div id="changes-result" className="changes-result flex min-w-0 flex-col gap-3" aria-live="polite">
        {'note' in result && result.note && <p className="text-muted-foreground">{result.note}</p>}
        {'title' in result && (
          <>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{result.title}</h2>
              <p className="text-xs text-muted-foreground">
                Dự án {result.slug} · {result.time}
              </p>
            </div>
            {result.content}
          </>
        )}
      </div>
    </ScreenBody>
  );
}

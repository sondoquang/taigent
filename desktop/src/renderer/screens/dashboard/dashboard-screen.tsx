// The Dashboard section (spec #64): the metrics of the open repository's project (`taigent metrics`, read-only),
// shown as the dashboard of the user's Role. Without a Role yet, the three choices sit in the page (no modal), so every
// other section stays reachable. The last read saved by the main process shows at once with its time, while the next
// read runs: the first time the section shows in a session, and each time another project opens (screens stay mounted
// while hidden, so nothing runs before the section is shown). A failed read keeps the numbers already on screen.

import { ChevronDown, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type Failure, type MetricsReport, type Role, ROLES } from '../../../shared/api.ts';
import { chooseRole } from '@/actions.ts';
import { Code, formatTime, PageHeader, ScreenBody, TableSkeleton } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { DeveloperDashboard } from '@/screens/dashboard/developer-dashboard.tsx';
import { api, ROLE_LABEL, useApp } from '@/store.ts';

const ROLE_PURPOSE: Record<Role, string> = {
  developer: 'Workload của team, việc bị block hoặc quá hạn, lead time và tốc độ xử lý bug.',
  productOwner: 'Tiến độ sprint, velocity, release burndown, bug trend và sức khoẻ project.',
  businessAnalyst: 'Pipeline phân tích, độ phủ acceptance criteria, mục chờ review hoặc chờ làm rõ.',
};

/** What the Dashboard shows for one project: its last numbers and the failure of the last read, if it failed. */
interface Shown {
  slug: string;
  report?: MetricsReport;
  failure?: Failure;
}

function Note({ reason, children }: { reason: string; children: ReactNode }) {
  return (
    <Empty id="dashboard-empty" className="border" data-reason={reason}>
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

/** The first-run choice: the three Roles in the page. */
function RoleChoice() {
  return (
    <section id="dashboard-role-choice" aria-labelledby="dashboard-role-choice-title" className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 id="dashboard-role-choice-title" className="text-lg font-medium">
          Bạn xem Dashboard với vai trò nào?
        </h2>
        <p className="text-muted-foreground">Đổi lại lúc nào cũng được, bằng menu vai trò trên Dashboard hoặc trong Settings.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        {ROLES.map((role) => (
          <Card key={role} className="min-w-0">
            <CardHeader>
              <CardTitle>
                <h3>{ROLE_LABEL[role]}</h3>
              </CardTitle>
              <CardDescription>{ROLE_PURPOSE[role]}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button type="button" variant="outline" data-role={role} onClick={() => void chooseRole(role)}>
                Chọn {ROLE_LABEL[role]}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function RoleMenu({ role }: { role: Role }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button id="dashboard-role-menu" type="button" variant="outline" size="sm" data-role={role}>
          Vai trò: {ROLE_LABEL[role]}
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Xem Dashboard theo vai trò</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={role} onValueChange={(value) => void chooseRole(value)}>
          {ROLES.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice} data-role={choice}>
              {ROLE_LABEL[choice]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A Role whose dashboard another ticket of spec #64 fills: what it will show, and which ticket. */
function Placeholder({ id, ticket, children }: { id: string; ticket: number; children: ReactNode }) {
  return (
    <Empty id={id} className="border" data-placeholder={ticket}>
      <EmptyTitle>Dashboard này đang được làm (ticket #{ticket})</EmptyTitle>
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

function RoleDashboard({ role, report }: { role: Role; report: MetricsReport }) {
  if (role === 'developer') return <DeveloperDashboard report={report} />;
  if (role === 'productOwner') {
    return (
      <Placeholder id="dashboard-product-owner" ticket={71}>
        Ticket #71 lấp đầy khung này: tiến độ sprint hiện tại, velocity, planned vs completed, release burndown, bug trend,
        sức khoẻ project, và bảng theo sprint, theo epic (hiện ở mục Taiga &gt; Báo cáo).
      </Placeholder>
    );
  }
  return (
    <Placeholder id="dashboard-business-analyst" ticket={72}>
      Ticket #72 lấp đầy khung này: phân bố status của story (kèm Chưa apply), độ phủ yêu cầu, story chưa đủ acceptance
      criteria, mục chờ review và mục chờ làm rõ.
    </Placeholder>
  );
}

export function DashboardScreen() {
  const repo = useApp((s) => s.repo);
  const slug = useApp((s) => s.view?.slug);
  const role = useApp((s) => s.role);
  const shownSection = useApp((s) => s.section === 'dashboard');
  const [shown, setShown] = useState<Shown>();
  const [loading, setLoading] = useState(false);
  // Reads finished this session, success or failure: `data-reads`, which the smoke waits on.
  const [reads, setReads] = useState(0);
  // The project read this session (another one triggers a read), and the latest read (older answers are dropped).
  const readSlug = useRef<string>(undefined);
  const latest = useRef(0);

  async function load(target: string, withSaved: boolean): Promise<void> {
    const request = ++latest.current;
    setLoading(true);
    if (withSaved) {
      const saved = await api.cachedMetrics(target);
      if (request !== latest.current) return;
      setShown({ slug: target, report: saved.ok && saved.value ? saved.value : undefined });
    }
    const result = await api.readMetrics(target);
    if (request !== latest.current) return;
    setLoading(false);
    setReads((count) => count + 1);
    setShown((previous) => {
      const kept = previous?.slug === target ? previous.report : undefined;
      return result.ok ? { slug: target, report: result.value } : { slug: target, report: kept, failure: result };
    });
  }

  useEffect(() => {
    if (!shownSection || !slug || readSlug.current === slug) return;
    readSlug.current = slug;
    void load(slug, true);
  }, [shownSection, slug]);

  const current = shown && shown.slug === slug ? shown : undefined;
  const report = current?.report;
  const description = !slug ? (
    'Số liệu của dự án đang mở, theo vai trò của bạn. Chỉ đọc Taiga, không ghi gì.'
  ) : (
    <>
      Số liệu của <Code>{slug}</Code> trên Taiga, chỉ đọc.{' '}
      <span id="dashboard-generated-at" data-generated-at={report?.generatedAt ?? ''}>
        {report ? `Cập nhật lúc ${formatTime(report.generatedAt)}.` : loading ? 'Đang đọc lần đầu…' : 'Chưa có số liệu.'}
      </span>
    </>
  );

  // Without a Role the choice comes first, whether or not a project is open.
  let body: ReactNode = null;
  if (!repo) body = <Note reason="no-repo">Mở thư mục repo có <Code>taiga/&lt;slug&gt;/backlog.yaml</Code>, rồi chọn dự án.</Note>;
  else if (!slug) body = <Note reason="no-project">Chọn dự án ở thanh trên cùng: Dashboard hiện số liệu của dự án đó.</Note>;
  else if (role && report) body = <RoleDashboard role={role} report={report} />;
  else if (role && loading) body = <TableSkeleton label="Đang đọc số liệu…" />;

  return (
    <ScreenBody>
      <div
        id="dashboard"
        className="flex min-w-0 flex-col gap-6"
        data-state={loading ? 'loading' : 'idle'}
        data-reads={reads}
        data-slug={slug ?? ''}
        data-role={role ?? ''}
      >
        <PageHeader
          title="Dashboard"
          description={description}
          actions={
            <>
              {role && <RoleMenu role={role} />}
              {slug && (
                <Button id="dashboard-refresh" type="button" variant="outline" size="sm" disabled={loading} onClick={() => void load(slug, false)}>
                  {loading ? <Spinner /> : <RefreshCw aria-hidden="true" />}
                  Làm mới
                </Button>
              )}
            </>
          }
        />
        <div id="dashboard-status" aria-live="polite" className="min-w-0 empty:-mt-6">
          {slug && current?.failure && (
            <div id="dashboard-failure">
              <FailureBlock failure={current.failure} />
            </div>
          )}
        </div>
        {role === null && <RoleChoice />}
        {body}
      </div>
    </ScreenBody>
  );
}

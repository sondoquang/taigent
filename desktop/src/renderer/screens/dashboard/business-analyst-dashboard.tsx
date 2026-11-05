// Business Analyst dashboard: the `businessAnalyst` section of `taigent metrics` (GLOSSARY.md, Dashboards). The
// stories on Taiga by status, New read as "đang phân tích" and Ready as "đủ AC" (spec #64, story 42; the CLI keeps
// Taiga's names), with the backlog's stories not on Taiga as "Chưa apply"; the requirement change trend (edits of a
// story's description after it reached Ready, per period); then, from the backlog manifest and review.yaml,
// requirements coverage, complete acceptance criteria, the items awaiting review and those pending clarification.
// Without a valid backlog manifest those give way to a note that says why.

import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { MetricsReport } from '../../../shared/api.ts';
import { Code, formatTime, StatCell, StatusBadge, TYPE_LABEL } from '@/components/common.tsx';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart.tsx';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty.tsx';
import { periodLabel, Stats, Widget, type WidgetRow, WidgetTable } from '@/screens/dashboard/dashboard-parts.tsx';

type BusinessAnalyst = MetricsReport['businessAnalyst'];
type BacklogRef = NonNullable<BusinessAnalyst['requirementsCoverage']>['uncovered'][number];
type IncompleteStory = NonNullable<BusinessAnalyst['acceptanceCriteria']>['incomplete'][number];
type BacklogState = 'ok' | 'backlog-missing' | 'backlog-invalid';

/** How a Business Analyst reads the statuses of the analysis; the other statuses keep only Taiga's name. */
const STATUS_READING: Record<string, string> = { New: 'đang phân tích', Ready: 'đủ AC' };

const STATUS_CONFIG = { count: { label: 'Story', color: 'var(--chart-1)' } } satisfies ChartConfig;

const CHANGE_CONFIG = { changes: { label: 'Lần sửa', color: 'var(--chart-2)' } } satisfies ChartConfig;

const PART_NAME = { given: 'Given', when: 'When', then: 'Then' } as const;

function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** An item of the backlog: its subject, its key, and its ref when it is on Taiga (as the Backlog section shows it). */
function ItemCell({ item }: { item: BacklogRef }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{item.subject}</span>
      <span className="text-xs text-muted-foreground">
        <Code>{item.key}</Code> · {item.ref === null ? 'Mới' : `Đã đẩy #${item.ref}`}
      </span>
    </span>
  );
}

function itemRow(item: BacklogRef, extra: Record<string, string>, cells: ReactNode[]): WidgetRow {
  return { key: `${item.type}-${item.key}`, data: { 'data-item': item.key, ...extra }, cells: [TYPE_LABEL[item.type], <ItemCell item={item} />, ...cells] };
}

/** Why a story has no complete acceptance criteria. */
function incompleteReason(story: IncompleteStory): string {
  if (story.reason === 'legacy') return 'Định dạng cũ (legacy): acceptance criteria là danh sách, không có scenario Given/When/Then';
  if (story.reason === 'no-scenario') return 'Chưa có scenario nào';
  return story.scenarios.map(({ scenario, missing }) => `“${scenario}” thiếu ${missing.map((part) => PART_NAME[part]).join(', ')}`).join('; ');
}

/** Why the metrics of the backlog manifest are missing, with the CLI's own words below. */
function BacklogNote({ slug, state, message }: { slug: string; state: Exclude<BacklogState, 'ok'>; message?: string }) {
  const metrics = 'nhóm Chưa apply, độ phủ yêu cầu, acceptance criteria, mục chờ review và mục chờ làm rõ';
  return (
    <Empty id="dashboard-ba-backlog" className="border" data-reason={state}>
      <EmptyTitle>{state === 'backlog-missing' ? 'Chưa có backlog manifest' : 'Backlog manifest đang lỗi'}</EmptyTitle>
      <EmptyDescription>
        {state === 'backlog-missing' ? (
          <>
            Dự án chưa có <Code>taiga/{slug}/backlog.yaml</Code> trong repo, nên chưa có {metrics}: các số này tính từ
            backlog manifest và <Code>review.yaml</Code>. Cách sửa: lập backlog cho dự án (skill <Code>taiga-plan-backlog</Code>),
            rồi bấm Làm mới.
          </>
        ) : (
          <>
            Backlog manifest hoặc <Code>review.yaml</Code> của dự án không hợp lệ, nên chưa tính được {metrics}. Cách sửa:
            chạy <Code>taigent validate --project {slug}</Code>, sửa các lỗi nó báo, rồi bấm Làm mới.
          </>
        )}
      </EmptyDescription>
      {message && <p className="detail max-w-2xl text-xs break-words text-muted-foreground">{message}</p>}
    </Empty>
  );
}

/** The requirement changes of each period: a chart, and a table with the stories edited. */
function RequirementChangeWidget({ report }: { report: MetricsReport }) {
  // A read saved by an older taigent has no requirement change: the widget waits for the next read.
  const entries = report.businessAnalyst.requirementChange as BusinessAnalyst['requirementChange'] | undefined;
  const periodOf = new Map(report.periods.map((period) => [period.id, period]));
  const label = (id: string) => {
    const period = periodOf.get(id);
    return period ? periodLabel(period) : id;
  };
  const current = report.periods.find((period) => period.current) ?? report.periods.at(-1);
  const now = entries?.find((entry) => entry.period === current?.id);
  const trend = (entries ?? []).map((entry) => ({ label: label(entry.period), changes: entry.changes }));
  return (
    <Widget
      id="dashboard-ba-requirement-change"
      title="Requirement change"
      description="Số lần sửa mô tả (description) của story trên Taiga sau lần đầu story vào Ready, theo từng kỳ. Nhiều lần sửa là yêu cầu chưa ổn định."
    >
      {entries === undefined ? (
        <p className="empty text-muted-foreground">Lần đọc này từ phiên bản taigent cũ, chưa có requirement change. Bấm Làm mới để đọc lại.</p>
      ) : trend.length === 0 ? (
        <p className="empty text-muted-foreground">Chưa có kỳ nào.</p>
      ) : (
        <>
          <Stats>
            <StatCell label={current ? `Lần sửa trong kỳ ${periodLabel(current)}` : 'Lần sửa trong kỳ hiện tại'} value={now?.changes ?? 0} />
            <StatCell label="Story bị sửa trong kỳ" value={now?.stories.length ?? 0} />
          </Stats>
          <ChartContainer
            id="dashboard-ba-requirement-change-chart"
            config={CHANGE_CONFIG}
            className="aspect-auto h-56 w-full"
            role="img"
            aria-label={`Requirement change mỗi kỳ: ${trend.map((row) => `${row.label} ${row.changes} lần sửa`).join('; ')}`}
            data-series={trend.map((row) => row.changes).join(',')}
          >
            <BarChart accessibilityLayer data={trend}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="changes" fill="var(--color-changes)" radius={4} />
            </BarChart>
          </ChartContainer>
          <WidgetTable
            head={['Kỳ', 'Lần sửa', 'Story bị sửa']}
            empty="Chưa có kỳ nào."
            rows={entries.map((entry) => ({
              key: entry.period,
              data: { 'data-period': entry.period },
              cells: [
                label(entry.period),
                String(entry.changes),
                entry.stories.length === 0 ? '—' : entry.stories.map((story) => `#${story.ref} ${story.subject}${story.changes > 1 ? ` (${story.changes} lần)` : ''}`).join(', '),
              ],
            }))}
          />
        </>
      )}
    </Widget>
  );
}

export function BusinessAnalystDashboard({ report }: { report: MetricsReport }) {
  const { businessAnalyst: ba, unavailable } = report;
  const { acceptanceCriteria: criteria, requirementsCoverage: coverage, awaitingReview, pendingClarification } = ba;
  const { stories: statuses, notApplied } = ba.statuses;
  const missing = unavailable.find((entry) => entry.metric === 'businessAnalyst.acceptanceCriteria');
  const backlog: BacklogState = criteria ? 'ok' : missing?.reason === 'backlog-invalid' ? 'backlog-invalid' : 'backlog-missing';
  const onTaiga = statuses.reduce((sum, { count }) => sum + count, 0);
  const chart = [
    ...statuses.map(({ status, count }) => ({ label: STATUS_READING[status] ? `${status} (${STATUS_READING[status]})` : status, count })),
    ...(notApplied === undefined ? [] : [{ label: 'Chưa apply', count: notApplied }]),
  ];
  const statusRows: WidgetRow[] = [
    ...statuses.map(({ status, closed, count }) => ({
      key: status,
      data: { 'data-status': status },
      cells: [
        <span>
          {status}
          {STATUS_READING[status] && <span className="text-muted-foreground"> · {STATUS_READING[status]}</span>}
          {closed && <span className="text-muted-foreground"> · đóng</span>}
        </span>,
        String(count),
      ],
    })),
    ...(notApplied === undefined
      ? []
      : [{ key: 'not-applied', data: { 'data-status': 'not-applied' }, cells: [<span>Chưa apply <span className="text-muted-foreground">· trong backlog, chưa có trên Taiga</span></span>, String(notApplied)] }]),
  ];

  return (
    <div id="dashboard-business-analyst" className="flex min-w-0 flex-col gap-6" data-backlog={backlog}>
      {backlog !== 'ok' && <BacklogNote slug={report.project.slug} state={backlog} message={missing?.message} />}

      <Widget id="dashboard-ba-statuses" title="Pipeline phân tích" description="Story trên Taiga theo status, theo thứ tự status của project. New là đang phân tích, Ready là đã đủ acceptance criteria.">
        <Stats>
          <StatCell label="Story trên Taiga" value={onTaiga} />
          {notApplied !== undefined && <StatCell label="Chưa apply (story của backlog chưa có trên Taiga)" value={notApplied} tone="new" />}
        </Stats>
        <ChartContainer
          id="dashboard-ba-statuses-chart"
          config={STATUS_CONFIG}
          className="aspect-auto w-full"
          style={{ height: chart.length * 32 + 24 }}
          role="img"
          aria-label={`Số story theo status: ${chart.map((row) => `${row.label} ${row.count}`).join('; ')}`}
          data-series={chart.map((row) => row.count).join(',')}
        >
          <BarChart accessibilityLayer data={chart} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={160} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
          </BarChart>
        </ChartContainer>
        <WidgetTable head={['Status', 'Story']} empty="Project chưa có status nào cho user story." rows={statusRows} />
      </Widget>

      <RequirementChangeWidget report={report} />

      {coverage && criteria && (
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
          <Widget id="dashboard-ba-coverage" title="Độ phủ yêu cầu" description="Epic có ít nhất một story đủ acceptance criteria.">
            <Stats>
              <StatCell label="Epic có story đủ AC" value={`${coverage.covered} / ${coverage.epics}`} />
              <StatCell label="Độ phủ yêu cầu" value={percent(coverage.rate)} tone={coverage.uncovered.length === 0 ? 'approved' : undefined} />
            </Stats>
            <WidgetTable head={['Loại', 'Epic chưa được phủ']} empty="Epic nào cũng có story đủ acceptance criteria." rows={coverage.uncovered.map((epic) => itemRow(epic, {}, []))} />
          </Widget>
          <Widget id="dashboard-ba-criteria" title="Acceptance criteria" description="Story đủ AC khi có ít nhất một scenario đủ Given, When và Then. Story định dạng cũ (legacy) luôn tính là chưa đủ.">
            <Stats>
              <StatCell label="Story đủ AC" value={`${criteria.complete} / ${criteria.stories}`} />
              <StatCell label="Tỉ lệ đủ AC" value={percent(criteria.rate)} tone={criteria.incomplete.length === 0 ? 'approved' : undefined} />
            </Stats>
            <WidgetTable
              head={['Loại', 'Story chưa đủ AC', 'Lý do']}
              empty="Story nào cũng đủ acceptance criteria."
              rows={criteria.incomplete.map((story) => itemRow(story, { 'data-reason': story.reason }, [incompleteReason(story)]))}
            />
          </Widget>
        </div>
      )}

      {awaitingReview && pendingClarification && (
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
          <Widget id="dashboard-ba-review" title={`Chờ review (${awaitingReview.length})`} description="Item của backlog chưa có verdict, hoặc đã đổi sau khi duyệt.">
            <WidgetTable
              head={['Loại', 'Item', 'Review']}
              empty="Item nào cũng đã được duyệt."
              rows={awaitingReview.map((item) =>
                itemRow(item, { 'data-reason': item.reason }, [
                  item.reason === 'stale' ? <StatusBadge tone="stale">Đã đổi sau khi duyệt</StatusBadge> : <StatusBadge tone="unreviewed">Chưa duyệt</StatusBadge>,
                ]),
              )}
            />
          </Widget>
          <Widget id="dashboard-ba-clarification" title={`Chờ làm rõ (${pendingClarification.length})`} description="Item còn góp ý chưa xử lý trong review.yaml.">
            <WidgetTable
              head={['Loại', 'Item', 'Góp ý chưa xử lý']}
              empty="Không còn góp ý nào chưa xử lý."
              rows={pendingClarification.map((item) =>
                itemRow(item, {}, [
                  <ul className="flex flex-col gap-1">
                    {item.comments.map((comment) => (
                      <li key={comment.id}>
                        <span className="font-medium">{comment.by}</span> <span className="text-muted-foreground">({formatTime(comment.at)})</span>: {comment.text}
                      </li>
                    ))}
                  </ul>,
                ]),
              )}
            />
          </Widget>
        </div>
      )}
    </div>
  );
}

// Product Owner dashboard: the `productOwner` section of `taigent metrics` (GLOSSARY.md, Dashboards). Health first
// (each signal's colour and why), then the current sprint against its ideal line, velocity, planned vs completed
// (labelled by its `basis`), the scope change of each sprint, the release burndowns with their warnings, the bug trend,
// and the sprint and epic tables that the Báo cáo card of the Taiga section used to show (`productOwner.report`: no
// `taigent report` run). A kanban project has no sprint widgets: a note says why.

import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from 'recharts';
import type { MetricsReport } from '../../../shared/api.ts';
import { StatCell, StatusBadge, type Tone } from '@/components/common.tsx';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart.tsx';
import { periodNames, Stats, Widget, WidgetTable } from '@/screens/dashboard/dashboard-parts.tsx';

type ProductOwner = MetricsReport['productOwner'];
type Health = ProductOwner['health'];
type HealthLevel = Health['overdue']['level'];
type CurrentSprint = NonNullable<ProductOwner['currentSprint']>;
type Release = ProductOwner['releaseBurndown']['releases'][number];
type ScopeSide = NonNullable<ProductOwner['scopeChange']>[number]['added'];

const SPRINT_CONFIG = {
  remaining: { label: 'Point còn lại', color: 'var(--chart-1)' },
  ideal: { label: 'Đường lý tưởng', color: 'var(--chart-5)' },
} satisfies ChartConfig;

const VELOCITY_CONFIG = {
  points: { label: 'Point đóng', color: 'var(--chart-1)' },
} satisfies ChartConfig;

const BUG_CONFIG = {
  created: { label: 'Bug tạo', color: 'var(--chart-4)' },
  resolved: { label: 'Bug resolved', color: 'var(--chart-2)' },
  reopened: { label: 'Bug reopened', color: 'var(--chart-5)' },
  open: { label: 'Bug mở cuối kỳ', color: 'var(--chart-3)' },
} satisfies ChartConfig;

/** What planned is for each `basis` of the CLI: the chart series' label and the sentence above the chart. */
const BASIS: Record<string, { series: string; text: string }> = {
  'sprint-start': { series: 'Planned (lúc bắt đầu sprint)', text: 'Planned là số point của các story nằm trong sprint vào ngày sprint bắt đầu.' },
};

const LEVEL: Record<HealthLevel, { label: string; tone: Tone }> = {
  green: { label: 'Xanh', tone: 'approved' },
  yellow: { label: 'Vàng', tone: 'changes' },
  red: { label: 'Đỏ', tone: 'stale' },
};

const number = (value: number) => value.toLocaleString('vi-VN');
/** A day as the chart axes show it: DD/MM. */
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function sprintPaceReason(pace: NonNullable<Health['sprintPace']>, sprint: CurrentSprint | null | undefined): string {
  if (!sprint || pace.sprint === null) return 'Hôm nay không có sprint nào đang chạy.';
  const left = sprint.points.total - sprint.points.done;
  const where =
    (pace.behindPoints ?? 0) > 0
      ? `chậm ${number(pace.behindPoints ?? 0)} point (${number(pace.behindPercent ?? 0)}% tổng point) so với đường lý tưởng`
      : 'đúng hoặc nhanh hơn đường lý tưởng';
  return `${sprint.name} ${where}: còn ${number(left)}/${number(sprint.points.total)} point ở ngày ${sprint.days.elapsed}/${sprint.days.total}.`;
}

function openBugsReason(risingPeriods: number, open: number[]): string {
  if (open.length < 2) return 'Chưa đủ hai kỳ để so sánh số bug mở cuối kỳ.';
  const shown = open.slice(-3).join(' → ');
  if (risingPeriods === 0) return `Số bug mở cuối kỳ không tăng ở kỳ gần nhất (${shown}).`;
  return `Số bug mở cuối kỳ tăng ${risingPeriods === 1 ? 'ở kỳ gần nhất' : 'hai kỳ liên tiếp'} (${shown}).`;
}

interface SignalRow {
  key: string;
  name: string;
  rule: string;
  level: HealthLevel;
  reason: string;
  /** The CLI's own reason, in English. */
  detail: string;
}

function HealthWidget({ productOwner }: { productOwner: ProductOwner }) {
  const { health, currentSprint, bugTrend } = productOwner;
  const signals: SignalRow[] = [
    ...(health.sprintPace
      ? [{ key: 'sprintPace', name: 'Tiến độ sprint', rule: 'chậm hơn 10% tổng point là vàng, hơn 25% là đỏ', level: health.sprintPace.level, reason: sprintPaceReason(health.sprintPace, currentSprint), detail: health.sprintPace.reason }]
      : []),
    {
      key: 'overdue',
      name: 'Quá hạn',
      rule: '1–2 story và task là vàng, từ 3 là đỏ',
      level: health.overdue.level,
      reason: `${health.overdue.stories} story và ${health.overdue.tasks} task đang mở đã quá hạn.`,
      detail: health.overdue.reason,
    },
    {
      key: 'openBugs',
      name: 'Bug mở',
      rule: 'tăng 1 kỳ là vàng, tăng 2 kỳ liên tiếp là đỏ',
      level: health.openBugs.level,
      reason: openBugsReason(health.openBugs.risingPeriods, bugTrend.map((entry) => entry.open)),
      detail: health.openBugs.reason,
    },
    {
      key: 'blocked',
      name: 'Bị block',
      rule: '1 story là vàng, từ 2 là đỏ',
      level: health.blocked.level,
      reason: `${health.blocked.stories} user story đang mở bị block.`,
      detail: health.blocked.reason,
    },
  ];
  return (
    <Widget id="dashboard-health" title="Sức khoẻ project" description="Bốn tín hiệu, mỗi tín hiệu xanh, vàng hoặc đỏ kèm lý do bằng số liệu. Ngưỡng cố định.">
      <ul className="flex flex-col divide-y">
        {signals.map((signal) => (
          <li key={signal.key} className="flex flex-wrap items-start gap-3 py-3 first:pt-0 last:pb-0" data-signal={signal.key} data-level={signal.level}>
            <StatusBadge tone={LEVEL[signal.level].tone} className="mt-0.5">
              {LEVEL[signal.level].label}
            </StatusBadge>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-medium">{signal.name}</p>
              <p className="reason" title={signal.detail}>
                {signal.reason}
              </p>
              <p className="text-muted-foreground text-xs">Ngưỡng: {signal.rule}.</p>
            </div>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

function SprintWidget({ sprint }: { sprint: CurrentSprint | null }) {
  if (!sprint) {
    return (
      <Widget id="dashboard-sprint" title="Sprint hiện tại">
        <p className="empty text-muted-foreground">Hôm nay không có sprint nào đang chạy.</p>
      </Widget>
    );
  }
  const left = sprint.points.total - sprint.points.done;
  const data = sprint.ideal.map((point, index) => ({ label: shortDay(point.day), ideal: point.points, remaining: index === sprint.days.elapsed ? left : null }));
  return (
    <Widget
      id="dashboard-sprint"
      title={`Sprint hiện tại: ${sprint.name}`}
      description={`${sprint.start} → ${sprint.finish}. Đường lý tưởng giảm đều từ tổng point ngày đầu về 0 ngày cuối; chấm là số point còn lại hôm nay.`}
    >
      <Stats>
        <StatCell label="Point xong / tổng" value={`${sprint.points.done}/${sprint.points.total}`} tone="approved" />
        <StatCell label="Story xong / tổng" value={`${sprint.stories.done}/${sprint.stories.total}`} />
        <StatCell label="Task xong / tổng" value={`${sprint.tasks.done}/${sprint.tasks.total}`} />
        <StatCell label="Ngày đã qua / tổng" value={`${sprint.days.elapsed}/${sprint.days.total}`} />
      </Stats>
      <ChartContainer
        id="dashboard-sprint-chart"
        config={SPRINT_CONFIG}
        className="aspect-auto h-56 w-full"
        role="img"
        aria-label={`Sprint ${sprint.name}: còn ${left} trên ${sprint.points.total} point ở ngày ${sprint.days.elapsed} trên ${sprint.days.total}`}
        data-series={sprint.ideal.map((point) => point.points).join(',')}
      >
        <LineChart accessibilityLayer data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Line dataKey="ideal" type="linear" stroke="var(--color-ideal)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />
          <Line dataKey="remaining" type="linear" stroke="var(--color-remaining)" dot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
    </Widget>
  );
}

function ReleaseChart({ release }: { release: Release }) {
  const data = release.days.map((entry) => ({ label: shortDay(entry.day), remaining: entry.remaining, ideal: entry.ideal }));
  return (
    <ChartContainer
      id={`dashboard-release-chart-${release.version}`}
      config={SPRINT_CONFIG}
      className="aspect-auto h-48 w-full"
      role="img"
      aria-label={`Release ${release.version}: còn ${release.points.remaining} trên ${release.points.total} point`}
      data-series={release.days.map((entry) => entry.remaining ?? '').join(',')}
    >
      <LineChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        {release.declared && <Line dataKey="ideal" type="linear" stroke="var(--color-ideal)" strokeDasharray="4 4" dot={false} isAnimationActive={false} />}
        <Line dataKey="remaining" type="stepAfter" stroke="var(--color-remaining)" dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}

function ReleaseWidget({ burndown }: { burndown: ProductOwner['releaseBurndown'] }) {
  const { releases, multiTagged } = burndown;
  const warnings: { key: string; code: string; text: string }[] = [
    ...releases
      .filter((release) => !release.declared)
      .map((release) => ({
        key: `undeclared-${release.version}`,
        code: 'release-undeclared',
        text: `Tag ${release.tag} có trên ${release.stories.total} story nhưng project.yaml chưa khai báo release ${release.version}: burndown vẽ không có đường lý tưởng.`,
      })),
    ...releases
      .filter((release) => release.declared && release.stories.total === 0)
      .map((release) => ({ key: `empty-${release.version}`, code: 'release-empty', text: `Release ${release.version} đã khai báo trong project.yaml nhưng chưa story nào chỉ mang tag ${release.tag}.` })),
    ...multiTagged.map((story) => ({
      key: `multiple-${story.id}`,
      code: 'release-multiple',
      text: `Story #${story.ref} ${story.subject} mang ${story.releases.map((version) => `release:${version}`).join(', ')}: không tính vào burndown nào.`,
    })),
  ];
  return (
    <Widget
      id="dashboard-release"
      title={`Release burndown (${releases.length})`}
      description="Release là các story mang đúng một tag release:<version> trên Taiga; ngày đích khai báo ở releases của project.yaml. Đường lý tưởng đi từ ngày tạo story sớm nhất tới ngày đích."
    >
      {warnings.length > 0 && (
        <Alert id="dashboard-release-warnings" className="warn-box border-warning-border bg-warning-bg">
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertTitle>Release lệch giữa Taiga và project.yaml ({warnings.length})</AlertTitle>
          <AlertDescription className="text-foreground">
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((warning) => (
                <li key={warning.key} data-warning={warning.code}>
                  {warning.text}
                </li>
              ))}
            </ul>
            <p>Cách sửa: khai báo release trong releases của project.yaml, hoặc sửa tag release: của story trên Taiga.</p>
          </AlertDescription>
        </Alert>
      )}
      {releases.length === 0 ? (
        <p className="empty text-muted-foreground">Chưa có release nào: project.yaml không khai báo releases và không story nào mang tag release:.</p>
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          {releases.map((release) => (
            <section
              key={release.version}
              className="release flex min-w-0 flex-col gap-3"
              data-release={release.version}
              data-declared={String(release.declared)}
              data-stories={release.stories.total}
              aria-label={`Release ${release.version}`}
            >
              <h3 className="flex flex-wrap items-center gap-2 font-medium">
                {release.version}
                {release.declared ? (
                  <span className="text-muted-foreground text-sm font-normal">đích {release.target}</span>
                ) : (
                  <StatusBadge tone="changes">Chưa khai báo</StatusBadge>
                )}
                {release.declared && release.stories.total === 0 && <StatusBadge tone="changes">Chưa có story</StatusBadge>}
              </h3>
              <Stats>
                <StatCell label="Story đóng / tổng" value={`${release.stories.closed}/${release.stories.total}`} />
                <StatCell label="Point còn lại" value={release.points.remaining} />
                <StatCell label="Point tổng" value={release.points.total} />
              </Stats>
              {release.days.length > 0 && <ReleaseChart release={release} />}
            </section>
          ))}
        </div>
      )}
    </Widget>
  );
}

function ReportTables({ report }: { report: ProductOwner['report'] }) {
  const { sprints, epics, noEpic, outsideSprints } = report;
  return (
    <>
      <Widget id="dashboard-report-sprints" title={`Theo sprint (${sprints.length})`} description="Sprint mới nhất trước. Story xong là story Taiga đã đóng; task xong là task có status đã đóng.">
        <WidgetTable
          head={['Sprint', 'Ngày', 'Trạng thái', 'Story xong', 'Task xong', 'Point xong', 'Story bị block']}
          empty="Project chưa có sprint."
          rows={sprints.map((sprint) => ({
            key: String(sprint.id),
            data: { 'data-sprint': String(sprint.id) },
            cells: [
              sprint.name,
              `${sprint.start} → ${sprint.finish}`,
              sprint.closed ? 'Đã đóng' : 'Đang chạy',
              `${sprint.stories.done}/${sprint.stories.total}`,
              `${sprint.tasks.done}/${sprint.tasks.total}`,
              `${sprint.points.done}/${sprint.points.total}`,
              sprint.blocked.length === 0 ? (
                '—'
              ) : (
                <ul className="list-disc space-y-1 pl-4">
                  {sprint.blocked.map((story) => (
                    <li key={story.ref}>{`#${story.ref} ${story.subject} (${story.status})`}</li>
                  ))}
                </ul>
              ),
            ],
          }))}
        />
      </Widget>
      <Widget id="dashboard-report-epics" title={`Theo epic (${epics.length})`} description="Story xong và đang mở của từng epic, và các story không thuộc epic nào.">
        <WidgetTable
          head={['Epic', 'Story xong', 'Story mở']}
          empty="Project chưa có epic."
          rows={[
            ...epics.map((epic) => ({ key: String(epic.id), data: { 'data-epic': String(epic.ref) }, cells: [`#${epic.ref} ${epic.subject}`, String(epic.stories.done), String(epic.stories.open)] })),
            { key: 'none', data: { 'data-epic': 'none' }, cells: ['Không thuộc epic nào', String(noEpic.done), String(noEpic.open)] },
          ]}
        />
      </Widget>
      <Widget id="dashboard-report-outside" title={`Story ngoài sprint (${outsideSprints.stories.length})`} description={`${outsideSprints.done} xong, ${outsideSprints.open} mở.`}>
        <WidgetTable
          head={['Story', 'Trạng thái', 'Point', 'Block']}
          empty="Mọi story đều nằm trong một sprint."
          rows={outsideSprints.stories.map((story) => ({
            key: String(story.ref),
            data: { 'data-story': String(story.ref) },
            cells: [`#${story.ref} ${story.subject}`, story.status, story.points === null ? '—' : String(story.points), story.blocked ? 'Bị block' : ''],
          }))}
        />
      </Widget>
    </>
  );
}

/** One side of a sprint's scope change: how many stories and points, then each story with its points and day. */
function ScopeCell({ side }: { side: ScopeSide }) {
  if (side.stories.length === 0) return '—';
  return (
    <>
      <span>{`${side.stories.length} story, ${number(side.points)} point`}</span>
      <ul className="list-disc space-y-1 pl-4">
        {side.stories.map((story) => (
          <li key={`${story.id}:${story.day}`}>{`#${story.ref} ${story.subject} (${story.points === null ? 'chưa ước lượng' : `${number(story.points)} point`}, ${story.day})`}</li>
        ))}
      </ul>
    </>
  );
}

function ScopeChangeWidget({ scopeChange, periods }: { scopeChange: NonNullable<ProductOwner['scopeChange']>; periods: MetricsReport['periods'] }) {
  const label = periodNames(periods);
  return (
    <Widget
      id="dashboard-scope"
      title="Scope change"
      description="Story được thêm vào hoặc rút ra khỏi sprint sau ngày bắt đầu, tới ngày cuối của sprint (dựng lại từ history của Taiga), kèm point hiện tại của story."
    >
      <WidgetTable
        head={['Sprint', 'Thêm vào', 'Rút ra']}
        empty="Chưa có sprint nào bắt đầu."
        rows={scopeChange.map((entry) => ({
          key: entry.period,
          data: { 'data-period': entry.period, 'data-added': String(entry.added.points), 'data-removed': String(entry.removed.points) },
          cells: [label(entry.period), <ScopeCell side={entry.added} />, <ScopeCell side={entry.removed} />],
        }))}
      />
    </Widget>
  );
}

function SprintWidgets({ report }: { report: MetricsReport }): ReactNode {
  const { productOwner, periods } = report;
  const label = periodNames(periods);
  const velocity = (productOwner.velocity ?? []).map((entry) => ({ label: entry.name, points: entry.points }));
  const planned = productOwner.planned;
  const plannedData = (planned?.sprints ?? []).map((entry) => ({ label: label(entry.period), planned: entry.planned, completed: entry.completed }));
  const basis = planned ? BASIS[planned.basis] : undefined;
  return (
    <>
      <SprintWidget sprint={productOwner.currentSprint ?? null} />
      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        <Widget id="dashboard-velocity" title="Velocity" description="Point đã đóng của tối đa 6 sprint đã đóng gần nhất.">
          {velocity.length === 0 ? (
            <p className="empty text-muted-foreground">Chưa có sprint nào đóng.</p>
          ) : (
            <ChartContainer
              id="dashboard-velocity-chart"
              config={VELOCITY_CONFIG}
              className="aspect-auto h-56 w-full"
              role="img"
              aria-label={`Velocity: ${velocity.map((row) => `${row.label} ${row.points} point`).join('; ')}`}
              data-series={velocity.map((row) => row.points).join(',')}
            >
              <BarChart accessibilityLayer data={velocity}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="points" fill="var(--color-points)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </Widget>
        <Widget id="dashboard-planned" title="Planned vs completed" description="Point planned và point đã đóng của từng sprint.">
          {planned && (
            <p id="dashboard-planned-basis" className="text-muted-foreground" data-basis={planned.basis}>
              {basis?.text ?? planned.basis}
            </p>
          )}
          {plannedData.length === 0 ? (
            <p className="empty text-muted-foreground">Chưa có sprint nào bắt đầu.</p>
          ) : (
            <ChartContainer
              id="dashboard-planned-chart"
              config={{ planned: { label: basis?.series ?? 'Planned', color: 'var(--chart-5)' }, completed: { label: 'Completed', color: 'var(--chart-2)' } } satisfies ChartConfig}
              className="aspect-auto h-56 w-full"
              role="img"
              aria-label={`${basis?.series ?? 'Planned'} và completed: ${plannedData.map((row) => `${row.label} ${row.completed}/${row.planned} point`).join('; ')}`}
              data-series={plannedData.map((row) => `${row.planned}/${row.completed}`).join(',')}
            >
              <BarChart accessibilityLayer data={plannedData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="planned" fill="var(--color-planned)" radius={4} />
                <Bar dataKey="completed" fill="var(--color-completed)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </Widget>
      </div>
      {productOwner.scopeChange && <ScopeChangeWidget scopeChange={productOwner.scopeChange} periods={periods} />}
    </>
  );
}

export function ProductOwnerDashboard({ report }: { report: MetricsReport }) {
  const { productOwner, periods } = report;
  const label = periodNames(periods);
  const bugTrend = productOwner.bugTrend.map((entry) => ({ label: label(entry.period), created: entry.created, resolved: entry.resolved, reopened: entry.reopened, open: entry.open }));

  return (
    <div id="dashboard-product-owner" className="flex min-w-0 flex-col gap-6" data-cadence={report.cadence}>
      <HealthWidget productOwner={productOwner} />

      {report.cadence === 'sprint' ? (
        <SprintWidgets report={report} />
      ) : (
        <Widget id="dashboard-po-kanban" title="Sprint">
          <p className="empty text-muted-foreground">
            Project này không bật module Backlog (sprint) trên Taiga, nên không có tiến độ sprint, velocity, planned vs completed và scope
            change. Các xu hướng tính theo tuần, thứ Hai đến Chủ nhật.
          </p>
        </Widget>
      )}

      <ReleaseWidget burndown={productOwner.releaseBurndown} />

      <Widget
        id="dashboard-bug-trend"
        title="Bug trend"
        description="Mỗi kỳ: bug tạo trong kỳ, bug resolved (Ready for test hoặc Closed) trong kỳ, bug reopened (từ Ready for test hoặc Closed quay lại status đang mở) trong kỳ và bug còn mở ở cuối kỳ, theo history của Taiga."
      >
        {bugTrend.length === 0 ? (
          <p className="empty text-muted-foreground">Chưa có kỳ nào.</p>
        ) : (
          <ChartContainer
            id="dashboard-bug-trend-chart"
            config={BUG_CONFIG}
            className="aspect-auto h-56 w-full"
            role="img"
            aria-label={`Bug trend: ${bugTrend.map((row) => `${row.label} ${row.created} tạo, ${row.resolved} resolved, ${row.reopened} reopened, ${row.open} mở`).join('; ')}`}
            data-series={bugTrend.map((row) => `${row.created}/${row.resolved}/${row.reopened}/${row.open}`).join(',')}
          >
            <ComposedChart accessibilityLayer data={bugTrend}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="created" fill="var(--color-created)" radius={4} />
              <Bar dataKey="resolved" fill="var(--color-resolved)" radius={4} />
              <Bar dataKey="reopened" fill="var(--color-reopened)" radius={4} />
              <Line dataKey="open" type="linear" stroke="var(--color-open)" isAnimationActive={false} />
            </ComposedChart>
          </ChartContainer>
        )}
        <WidgetTable
          head={['Kỳ', 'Tạo', 'Resolved', 'Rejected', 'Reopened', 'Mở cuối kỳ']}
          empty="Chưa có kỳ nào."
          rows={productOwner.bugTrend.map((entry) => ({
            key: entry.period,
            data: { 'data-period': entry.period },
            cells: [label(entry.period), String(entry.created), String(entry.resolved), String(entry.rejected), String(entry.reopened), String(entry.open)],
          }))}
        />
      </Widget>

      <ReportTables report={productOwner.report} />
    </div>
  );
}

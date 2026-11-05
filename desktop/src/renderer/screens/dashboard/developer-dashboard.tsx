// Developer dashboard: the `developer` section of `taigent metrics` (GLOSSARY.md, Dashboards). "Chỉ tôi" narrows it to
// the user the CLI logs in as, here in the renderer: the `mine` figures, their own workload row, and the blocked and
// overdue items assigned to them; the CLI does not run again. A metric the run could not compute is a "Chưa có" cell
// with its reason (the report's `unavailable`).

import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { DeveloperItem, MedianDays, MetricsReport } from '../../../shared/api.ts';
import { StatCell } from '@/components/common.tsx';
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { days, periodLabel, Stats, UnavailableCells, Widget, type WidgetRow, WidgetTable } from '@/screens/dashboard/dashboard-parts.tsx';

const TREND_CONFIG = {
  stories: { label: 'Story', color: 'var(--chart-1)' },
  tasks: { label: 'Task', color: 'var(--chart-2)' },
} satisfies ChartConfig;

const TYPE_TEXT: Record<DeveloperItem['type'], string> = { story: 'Story', task: 'Task' };

/** A median time cell (lead time, cycle time); `metric` is its hook for the smoke, e.g. `developer.cycleTime.stories`. */
function timeCell(label: string, time: MedianDays, metric: string): ReactNode {
  return (
    <div className="min-w-0" data-metric={metric}>
      {time.medianDays === null ? (
        <StatCell label={`${label} (chưa có item nào đóng)`} value="—" />
      ) : (
        <StatCell label={`${label} (trung vị của ${time.count} item)`} value={days(time.medianDays)} />
      )}
    </div>
  );
}

function itemRows(items: DeveloperItem[], names: Map<number, string>): WidgetRow[] {
  return items.map((item) => ({
    key: `${item.type}-${item.id}`,
    data: { 'data-item': `${item.type}-${item.ref}` },
    cells: [
      TYPE_TEXT[item.type],
      `#${item.ref} ${item.subject}`,
      item.status,
      item.assignees.length === 0 ? 'Chưa giao' : item.assignees.map((id) => names.get(id) ?? `#${id}`).join(', '),
      item.dueDate ?? '—',
    ],
  }));
}

export function DeveloperDashboard({ report }: { report: MetricsReport }) {
  const [mine, setMine] = useState(false);
  const { developer, periods, unavailable } = report;
  const me = developer.me;
  const scope = mine ? 'mine' : 'all';
  const names = new Map(developer.people.map((person) => [person.id, person.username]));
  const periodOf = new Map(periods.map((period) => [period.id, period]));
  const label = (id: string) => {
    const period = periodOf.get(id);
    return period ? periodLabel(period) : id;
  };
  const current = periods.find((period) => period.current) ?? periods.at(-1);
  const throughput = developer.periods.find((entry) => entry.period === current?.id)?.[scope];
  const bugs = developer.bugs.periods.find((entry) => entry.period === current?.id)?.[scope];
  const lead = developer.leadTime[scope];
  // A read saved by an older taigent has no cycle time: its cells wait for the next read.
  const cycle = developer.cycleTime?.[scope];
  const assignedToMe = (item: DeveloperItem) => !mine || item.assignees.includes(me.id);
  const workload = mine ? developer.workload.filter((row) => row.assignee === me.id) : developer.workload;
  const blocked = developer.blocked.filter(assignedToMe);
  const overdue = developer.overdue.filter(assignedToMe);
  const trend = developer.periods.map((entry) => ({ label: label(entry.period), stories: entry[scope].stories.completed, tasks: entry[scope].tasks.completed }));
  const cadence = report.cadence === 'sprint' ? 'theo sprint' : 'theo tuần (thứ Hai đến Chủ nhật)';

  return (
    <div id="dashboard-developer" className="flex min-w-0 flex-col gap-6" data-scope={scope}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Switch id="dashboard-mine" checked={mine} onCheckedChange={setMine} />
          <Label htmlFor="dashboard-mine">Chỉ tôi ({me.username})</Label>
        </div>
        <p className="text-muted-foreground">
          {mine ? 'Chỉ việc được giao cho bạn' : 'Cả team'}, kỳ {cadence}.
        </p>
      </div>

      <Widget
        id="dashboard-throughput"
        title={current ? `Kỳ hiện tại: ${periodLabel(current)}` : 'Kỳ hiện tại'}
        description={current ? `${current.start} → ${current.finish}. Story và task đếm riêng; được giao là việc mở trong kỳ và có người làm.` : undefined}
      >
        {throughput ? (
          <Stats>
            <StatCell label="Story được giao" value={throughput.stories.assigned} />
            <StatCell label="Story hoàn thành" value={throughput.stories.completed} tone="approved" />
            <StatCell label="Task được giao" value={throughput.tasks.assigned} />
            <StatCell label="Task hoàn thành" value={throughput.tasks.completed} tone="approved" />
          </Stats>
        ) : (
          <p className="empty text-muted-foreground">Chưa có sprint nào bắt đầu.</p>
        )}
      </Widget>

      <Widget
        id="dashboard-times"
        title="Thời gian xử lý"
        description="Lead time: từ ngày tạo tới ngày đóng. Cycle time: từ lần đầu vào In progress (theo history trên Taiga) tới ngày đóng. Tính trên các item đóng trong các kỳ; Ready for test chưa tính là đóng."
      >
        <Stats>
          {timeCell('Lead time story', lead.stories, 'developer.leadTime.stories')}
          {timeCell('Lead time task', lead.tasks, 'developer.leadTime.tasks')}
          {cycle && timeCell('Cycle time story', cycle.stories, 'developer.cycleTime.stories')}
          {cycle && timeCell('Cycle time task', cycle.tasks, 'developer.cycleTime.tasks')}
        </Stats>
      </Widget>

      <Widget id="dashboard-trend" title="Xu hướng hoàn thành" description="Story và task đóng trong mỗi kỳ.">
        {trend.length === 0 ? (
          <p className="empty text-muted-foreground">Chưa có kỳ nào.</p>
        ) : (
          <ChartContainer
            id="dashboard-trend-chart"
            config={TREND_CONFIG}
            className="aspect-auto h-56 w-full"
            role="img"
            aria-label={`Story và task hoàn thành mỗi kỳ: ${trend.map((row) => `${row.label} ${row.stories} story, ${row.tasks} task`).join('; ')}`}
            data-series={trend.map((row) => `${row.stories}/${row.tasks}`).join(',')}
          >
            <BarChart accessibilityLayer data={trend}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="stories" fill="var(--color-stories)" radius={4} />
              <Bar dataKey="tasks" fill="var(--color-tasks)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </Widget>

      <Widget id="dashboard-bugs" title="Bug" description="Resolved: chuyển sang Ready for test hoặc Closed. Rejected đếm riêng, không tính là resolved.">
        <Stats>
          <StatCell label="Bug resolved trong kỳ" value={bugs?.resolved ?? 0} tone="approved" />
          <StatCell label="Bug bị Rejected trong kỳ" value={bugs?.rejected ?? 0} />
          {bugs?.resolutionTime.medianDays == null ? (
            <StatCell label="Resolution time (chưa có bug resolved)" value="—" />
          ) : (
            <StatCell label={`Resolution time (trung vị của ${bugs.resolutionTime.count} bug)`} value={days(bugs.resolutionTime.medianDays)} />
          )}
          <UnavailableCells unavailable={unavailable} metrics={['developer.bugs.reopenRate']} />
        </Stats>
        <WidgetTable
          head={['Kỳ', 'Resolved', 'Rejected', 'Resolution time']}
          empty="Chưa có kỳ nào."
          rows={developer.bugs.periods.map((entry) => ({
            key: entry.period,
            data: { 'data-period': entry.period },
            cells: [
              label(entry.period),
              String(entry[scope].resolved),
              String(entry[scope].rejected),
              entry[scope].resolutionTime.medianDays === null ? '—' : days(entry[scope].resolutionTime.medianDays),
            ],
          }))}
        />
      </Widget>

      <Widget id="dashboard-workload" title="Workload" description="Việc đang mở của mỗi người: story, task và point của các story đó. Story có hai người làm tính cho cả hai.">
        <WidgetTable
          head={['Người làm', 'Story mở', 'Task mở', 'Point']}
          empty={mine ? 'Bạn không có việc nào đang mở.' : 'Không có việc nào đang mở.'}
          rows={workload.map((row) => ({
            key: String(row.assignee),
            data: { 'data-assignee': row.assignee === null ? 'none' : String(row.assignee) },
            cells: [row.assignee === null ? 'Chưa giao' : (row.username ?? `#${row.assignee}`), String(row.stories), String(row.tasks), String(row.points)],
          }))}
        />
      </Widget>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
        <Widget id="dashboard-blocked" title={`Bị block (${blocked.length})`}>
          <WidgetTable head={['Loại', 'Item', 'Status', 'Người làm', 'Hạn']} empty="Không có item nào bị block." rows={itemRows(blocked, names)} />
        </Widget>
        <Widget id="dashboard-overdue" title={`Quá hạn (${overdue.length})`} description="Item mở có hạn trước hôm nay; hạn hôm nay chưa tính là quá hạn.">
          <WidgetTable head={['Loại', 'Item', 'Status', 'Người làm', 'Hạn']} empty="Không có item nào quá hạn." rows={itemRows(overdue, names)} />
        </Widget>
      </div>
    </div>
  );
}

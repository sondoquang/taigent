// Taiga > Báo cáo: one Taiga project's progress by sprint and by epic, and its stories in no sprint
// (`taigent report --project <slug> --json`, read-only). The project choice lists the Taiga projects of Taiga > Project,
// following each read of its list.

import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectReport, TaigaProjectsOverview } from '../../../shared/api.ts';
import { Code } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { api } from '@/store.ts';

function ReportTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <Table className="taiga-projects-table">
      <TableHeader>
        <TableRow>
          {head.map((cell) => (
            <TableHead key={cell}>{cell}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            {row.map((cell, column) => (
              <TableCell key={column} className="whitespace-normal break-words">
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Report({ report }: { report: ProjectReport }) {
  const { sprints, epics, noEpic, outsideSprints } = report;
  return (
    <div id="taiga-report-result" className="taiga-project-card flex flex-col gap-4 rounded-lg border p-4">
      <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {report.project.name}
        <Code>{report.project.slug}</Code>
      </h3>
      <h4 className="font-semibold">Theo sprint ({sprints.length})</h4>
      {sprints.length === 0 ? (
        <p className="text-muted-foreground">Project chưa có sprint.</p>
      ) : (
        <ReportTable
          head={['Sprint', 'Ngày', 'Trạng thái', 'Story xong', 'Task xong', 'Point xong', 'Story bị block']}
          rows={sprints.map((sprint) => [
            sprint.name,
            `${sprint.start} → ${sprint.finish}`,
            sprint.closed ? 'Đã đóng' : 'Đang chạy',
            `${sprint.stories.done}/${sprint.stories.total}`,
            `${sprint.tasks.done}/${sprint.tasks.total}`,
            `${sprint.points.done}/${sprint.points.total}`,
            sprint.blocked.length === 0 ? (
              '—'
            ) : (
              <ul className="taiga-report-blocked list-disc space-y-1 pl-4">
                {sprint.blocked.map((story) => (
                  <li key={story.ref}>{`#${story.ref} ${story.subject} (${story.status})`}</li>
                ))}
              </ul>
            ),
          ])}
        />
      )}
      <h4 className="font-semibold">Theo epic ({epics.length})</h4>
      <ReportTable
        head={['Epic', 'Story xong', 'Story mở']}
        rows={[
          ...epics.map((epic) => [`#${epic.ref} ${epic.subject}`, String(epic.stories.done), String(epic.stories.open)]),
          ['Không thuộc epic nào', String(noEpic.done), String(noEpic.open)],
        ]}
      />
      <h4 className="font-semibold">{`Story ngoài sprint (${outsideSprints.stories.length}): ${outsideSprints.done} xong, ${outsideSprints.open} mở`}</h4>
      {outsideSprints.stories.length > 0 && (
        <ReportTable
          head={['Story', 'Trạng thái', 'Point', 'Block']}
          rows={outsideSprints.stories.map((story) => [
            `#${story.ref} ${story.subject}`,
            story.status,
            story.points === null ? '—' : String(story.points),
            story.blocked ? 'Bị block' : '',
          ])}
        />
      )}
    </div>
  );
}

/** `overview` is the last read of Taiga > Project's list (a new object per read), undefined before the first one. */
export function ReportCard({ overview }: { overview: TaigaProjectsOverview | undefined }) {
  const slugs = overview ? overview.rows.filter((row) => row.taiga).map((row) => row.slug) : [];
  const [choice, setChoice] = useState('');
  const [status, setStatus] = useState('Chọn project khi mục Project ở trên đã đọc xong danh sách.');
  const [body, setBody] = useState<ReactNode>();
  const [running, setRunning] = useState(false);

  // Each read of the list: keep the chosen project while it is still listed, and say what to do (or why not).
  useEffect(() => {
    if (!overview) return;
    setChoice((previous) => (slugs.includes(previous) ? previous : (slugs[0] ?? '')));
    setStatus(overview.taigaMessage ?? (slugs.length === 0 ? 'Bạn chưa là thành viên project nào trên Taiga.' : 'Chọn project rồi bấm “Xem báo cáo”.'));
  }, [overview]);

  async function showReport(): Promise<void> {
    const slug = choice;
    if (!slug) return;
    setStatus(`Đang đọc báo cáo của ${slug}…`);
    setBody(undefined);
    setRunning(true);
    const result = await api.readTaigaReport(slug).finally(() => setRunning(false));
    setStatus(result.ok ? `Báo cáo của ${slug}, đọc lúc ${new Date().toLocaleString('vi-VN')}.` : '');
    setBody(result.ok ? <Report report={result.value} /> : <FailureBlock failure={result} />);
  }

  return (
    <Card id="taiga-report" className="taiga-report">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="mr-auto">
          <h2>Báo cáo</h2>
        </CardTitle>
        <NativeSelect id="taiga-report-project" size="sm" aria-label="Project của báo cáo" value={choice} onChange={(event) => setChoice(event.target.value)}>
          {slugs.map((slug) => (
            <NativeSelectOption key={slug} value={slug}>
              {slug}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button id="taiga-report-run" type="button" variant="outline" size="sm" disabled={running || slugs.length === 0} onClick={() => void showReport()}>
          {running && <Spinner />}
          Xem báo cáo
        </Button>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <p id="taiga-report-status" className="text-muted-foreground" aria-live="polite">
          {status}
        </p>
        <div id="taiga-report-body" className="min-w-0" aria-live="polite">
          {body}
        </div>
      </CardContent>
    </Card>
  );
}

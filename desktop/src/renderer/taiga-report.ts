// Taiga > Báo cáo: one Taiga project's progress by sprint and by epic, and its stories in no sprint
// (`taigent report --project <slug> --json`, read-only). The project choice lists the Taiga projects of Taiga > Project.

import type { Failure, ProjectReport, TaigaProjectsOverview, TaigentApi } from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { onTaigaProjectsListed } from './taiga-projects.ts';

export interface TaigaReportContext {
  api: TaigentApi;
  failureBlock(failure: Failure): HTMLElement;
}

let context: TaigaReportContext;

function table(head: string[], rows: (string | Node)[][]): HTMLElement {
  return h(
    'table',
    { class: 'taiga-projects-table' },
    h('thead', {}, h('tr', {}, ...head.map((cell) => h('th', {}, cell)))),
    h('tbody', {}, ...rows.map((row) => h('tr', {}, ...row.map((cell) => h('td', {}, cell))))),
  );
}

function renderReport(report: ProjectReport): HTMLElement {
  const { sprints, epics, noEpic, outsideSprints } = report;
  return h(
    'div',
    { class: 'taiga-project-card', id: 'taiga-report-result' },
    h('h2', {}, report.project.name, h('code', {}, report.project.slug)),
    h('h3', {}, `Theo sprint (${sprints.length})`),
    sprints.length === 0
      ? h('p', { class: 'muted' }, 'Project chưa có sprint.')
      : table(
          ['Sprint', 'Ngày', 'Trạng thái', 'Story xong', 'Task xong', 'Point xong', 'Story bị block'],
          sprints.map((sprint) => [
            sprint.name,
            `${sprint.start} → ${sprint.finish}`,
            sprint.closed ? 'Đã đóng' : 'Đang chạy',
            `${sprint.stories.done}/${sprint.stories.total}`,
            `${sprint.tasks.done}/${sprint.tasks.total}`,
            `${sprint.points.done}/${sprint.points.total}`,
            sprint.blocked.length === 0
              ? '—'
              : h('ul', { class: 'taiga-report-blocked' }, ...sprint.blocked.map((story) => h('li', {}, `#${story.ref} ${story.subject} (${story.status})`))),
          ]),
        ),
    h('h3', {}, `Theo epic (${epics.length})`),
    table(
      ['Epic', 'Story xong', 'Story mở'],
      [
        ...epics.map((epic) => [`#${epic.ref} ${epic.subject}`, String(epic.stories.done), String(epic.stories.open)]),
        ['Không thuộc epic nào', String(noEpic.done), String(noEpic.open)],
      ],
    ),
    h('h3', {}, `Story ngoài sprint (${outsideSprints.stories.length}): ${outsideSprints.done} xong, ${outsideSprints.open} mở`),
    outsideSprints.stories.length > 0 &&
      table(
        ['Story', 'Trạng thái', 'Point', 'Block'],
        outsideSprints.stories.map((story) => [`#${story.ref} ${story.subject}`, story.status, story.points === null ? '—' : String(story.points), story.blocked ? 'Bị block' : '']),
      ),
  );
}

/** Fills the project choice with the Taiga projects of Taiga > Project; without them, says why. */
function listProjects(overview: TaigaProjectsOverview): void {
  const select = byId<HTMLSelectElement>('taiga-report-project');
  const previous = select.value;
  const slugs = overview.rows.filter((row) => row.taiga).map((row) => row.slug);
  select.replaceChildren(...slugs.map((slug) => h('option', { value: slug }, slug)));
  if (slugs.includes(previous)) select.value = previous;
  byId<HTMLButtonElement>('taiga-report-run').disabled = slugs.length === 0;
  byId('taiga-report-status').textContent =
    overview.taigaMessage ?? (slugs.length === 0 ? 'Bạn chưa là thành viên project nào trên Taiga.' : 'Chọn project rồi bấm “Xem báo cáo”.');
}

async function showReport(): Promise<void> {
  const slug = byId<HTMLSelectElement>('taiga-report-project').value;
  if (!slug) return;
  const button = byId<HTMLButtonElement>('taiga-report-run');
  const body = byId('taiga-report-body');
  byId('taiga-report-status').textContent = `Đang đọc báo cáo của ${slug}…`;
  body.replaceChildren();
  button.disabled = true;
  const result = await context.api.readTaigaReport(slug).finally(() => (button.disabled = false));
  byId('taiga-report-status').textContent = result.ok ? `Báo cáo của ${slug}, đọc lúc ${new Date().toLocaleString('vi-VN')}.` : '';
  body.replaceChildren(result.ok ? renderReport(result.value) : context.failureBlock(result));
}

/** Wires Taiga > Báo cáo; its project choice follows each read of Taiga > Project's list. */
export function mountTaigaReport(ctx: TaigaReportContext): void {
  context = ctx;
  byId('taiga-report-run').addEventListener('click', () => void showReport());
  onTaigaProjectsListed(listProjects);
}

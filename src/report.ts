// The read-only `report` command: a project's progress by sprint and by epic, and its stories in no sprint. The
// figures mean what the `taiga-status-report` skill reports: stories and tasks done from the sprint's stats (a story
// is done when Taiga closed it, a task when its status is closed), points from the sprint itself, epics from their
// related stories. The client disables Taiga's pagination, so every list is complete.

import { type TaigaClient, TaigaError, type TaigaStory } from './taiga/client.ts';

/** Done out of total. */
export interface Progress {
  done: number;
  total: number;
}

/** Done and still open stories. */
export interface StoryCounts {
  done: number;
  open: number;
}

/** A story as the report lists it. */
export interface ReportStory {
  ref: number;
  subject: string;
  status: string;
  closed: boolean;
  blocked: boolean;
  points: number | null;
}

export interface SprintReport {
  id: number;
  name: string;
  /** First and last day, YYYY-MM-DD. */
  start: string;
  finish: string;
  closed: boolean;
  stories: Progress;
  tasks: Progress;
  points: Progress;
  /** Its blocked stories, in Taiga's order. */
  blocked: ReportStory[];
}

export interface EpicReport {
  id: number;
  ref: number;
  subject: string;
  stories: StoryCounts;
}

export interface ProjectReport {
  project: { id: number; slug: string; name: string };
  /** Newest sprint first. */
  sprints: SprintReport[];
  epics: EpicReport[];
  /** Stories related to no epic. */
  noEpic: StoryCounts;
  /** Stories in no sprint, in Taiga's order. */
  outsideSprints: StoryCounts & { stories: ReportStory[] };
}

function reportStory(story: TaigaStory): ReportStory {
  return { ref: story.ref, subject: story.subject, status: story.status, closed: story.isClosed, blocked: story.isBlocked, points: story.totalPoints };
}

function countStories(stories: TaigaStory[]): StoryCounts {
  const done = stories.filter((story) => story.isClosed).length;
  return { done, open: stories.length - done };
}

/** The report of one visible project; exit 5 (TaigaError) when it is not visible. */
export async function readProjectReport(client: TaigaClient, slug: string): Promise<ProjectReport> {
  const project = await client.findProjectBySlug(slug);
  if (!project) throw new TaigaError(`project "${slug}" not found on ${client.apiUrl} (or not visible to this user)`, 404);
  const [milestones, stories, epics] = await Promise.all([client.listMilestones(project.id), client.listStories(project.id), client.listItems('epic', project.id)]);
  const [stats, epicStories] = await Promise.all([
    Promise.all(milestones.map((milestone) => client.getMilestoneStats(milestone.id))),
    Promise.all(epics.map((epic) => client.listEpicUserStories(epic.id))),
  ]);
  const byId = new Map(stories.map((story) => [story.id, story]));
  const inEpic = new Set(epicStories.flat());
  const outside = stories.filter((story) => story.milestone === null);
  const sprints = milestones.map((milestone, index): SprintReport => {
    const { totalStories, doneStories, totalTasks, doneTasks } = stats[index]!;
    return {
      id: milestone.id,
      name: milestone.name,
      start: milestone.start,
      finish: milestone.finish,
      closed: milestone.closed,
      stories: { done: doneStories, total: totalStories },
      tasks: { done: doneTasks, total: totalTasks },
      points: { done: milestone.closedPoints, total: milestone.totalPoints },
      blocked: stories.filter((story) => story.milestone === milestone.id && story.isBlocked).map(reportStory),
    };
  });
  return {
    project: { id: project.id, slug: project.slug, name: project.name },
    sprints: sprints.sort((a, b) => b.start.localeCompare(a.start) || b.id - a.id),
    epics: epics.map((epic, index) => ({
      id: epic.id,
      ref: epic.ref,
      subject: epic.subject,
      stories: countStories(epicStories[index]!.flatMap((id) => byId.get(id) ?? [])),
    })),
    noEpic: countStories(stories.filter((story) => !inEpic.has(story.id))),
    outsideSprints: { ...countStories(outside), stories: outside.map(reportStory) },
  };
}

export function formatProjectReportText(report: ProjectReport): string {
  const { project, sprints, epics, noEpic, outsideSprints } = report;
  const lines = [`Project ${project.name} (${project.slug})`, ''];
  if (sprints.length === 0) lines.push('No sprints.');
  else lines.push(`Sprints (${sprints.length}):`);
  for (const sprint of sprints) {
    lines.push(`  ${sprint.name}  ${sprint.start} → ${sprint.finish}  ${sprint.closed ? 'closed' : 'active'}`);
    const { stories, tasks, points } = sprint;
    lines.push(`    stories ${stories.done}/${stories.total} done, tasks ${tasks.done}/${tasks.total} done, points ${points.done}/${points.total} done`);
    for (const story of sprint.blocked) lines.push(`    blocked: #${story.ref} ${story.subject} (${story.status})`);
  }
  lines.push('');
  if (epics.length === 0) lines.push('No epics.');
  else lines.push(`Epics (${epics.length}):`);
  for (const epic of epics) lines.push(`  #${epic.ref} ${epic.subject}: ${epic.stories.done} done, ${epic.stories.open} open`);
  lines.push(`  No epic: ${noEpic.done} done, ${noEpic.open} open`, '');
  lines.push(`Stories in no sprint (${outsideSprints.stories.length}): ${outsideSprints.done} done, ${outsideSprints.open} open`);
  for (const story of outsideSprints.stories) lines.push(`  #${story.ref} ${story.subject} (${story.blocked ? `${story.status}, blocked` : story.status})`);
  return `${lines.join('\n')}\n`;
}

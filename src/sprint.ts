// `taigent sprint`: list a project's sprints (Taiga milestones) with their user stories, create a sprint, and put
// existing user stories into one. A person runs it through the review gate; manifests and `apply` still never write
// sprints (docs/taiga/conventions.md §6).
//
// Both writes are planned first and are idempotent: a sprint with the same name and days is left as it is, a story
// already in the sprint is left as it is. Every name or ref is checked before anything is written.

import { summarize, tally, type PlanSummary } from './operations.ts';
import { type TaigaClient, TaigaConflictError, type TaigaMilestone, type TaigaStory } from './taiga/client.ts';

/** An unknown sprint or ref, or a sprint name taken with other days. Maps to ExitCode.Usage. */
export class SprintError extends Error {}

interface SprintProject {
  id: number;
  slug: string;
  name: string;
}

/** A story as `sprint` names it. */
export interface SprintStory {
  ref: number;
  subject: string;
}

/** `sprint list`: every sprint, newest first, with its stories in Taiga's order. */
export interface SprintList {
  project: SprintProject;
  sprints: { id: number; name: string; start: string; finish: string; closed: boolean; stories: SprintStory[] }[];
}

export type SprintCreateAction = 'create' | 'skip';
export interface SprintCreateOperation {
  action: SprintCreateAction;
  name: string;
  /** First and last day, YYYY-MM-DD. */
  start: string;
  finish: string;
  /** The sprint's id: the existing one's when skipped, set once created. */
  id: number | null;
}

/** `sprint create`: one operation, `create` or `skip` (same name and days already on Taiga). */
export interface SprintCreatePlan extends PlanSummary<SprintCreateAction> {
  project: SprintProject;
  operations: SprintCreateOperation[];
}

export type SprintAddAction = 'update' | 'skip';
export interface SprintAddOperation {
  action: SprintAddAction;
  ref: number;
  id: number;
  subject: string;
  /** The sprint the story is in before (null: in no sprint). */
  from: { id: number; name: string } | null;
  /** OCC version read with the story. */
  version: number;
}

/** `sprint add`: one operation per story, `update` (moved into the sprint) or `skip` (already in it). */
export interface SprintAddPlan extends PlanSummary<SprintAddAction> {
  project: SprintProject;
  sprint: { id: number; name: string };
  operations: SprintAddOperation[];
}

const CREATE_ACTIONS = ['create', 'skip'] as const;
const ADD_ACTIONS = ['update', 'skip'] as const;

function sprintProject(project: SprintProject): SprintProject {
  return { id: project.id, slug: project.slug, name: project.name };
}

function newestFirst(a: TaigaMilestone, b: TaigaMilestone): number {
  return b.start.localeCompare(a.start) || b.id - a.id;
}

/** Every sprint of `slug` with the refs and subjects of its stories. Read-only. */
export async function readSprints(client: TaigaClient, slug: string): Promise<SprintList> {
  const project = await client.getProjectBySlug(slug);
  const [milestones, stories] = await Promise.all([client.listMilestones(project.id), client.listStories(project.id)]);
  return {
    project: sprintProject(project),
    sprints: [...milestones].sort(newestFirst).map((milestone) => ({
      id: milestone.id,
      name: milestone.name,
      start: milestone.start,
      finish: milestone.finish,
      closed: milestone.closed,
      stories: stories.filter((story) => story.milestone === milestone.id).map((story) => ({ ref: story.ref, subject: story.subject })),
    })),
  };
}

export function formatSprintListText({ project, sprints }: SprintList): string {
  const lines = [`Sprints of project ${project.name} (${project.slug}): ${sprints.length === 0 ? 'none' : sprints.length}`];
  for (const sprint of sprints) {
    lines.push(`  ${sprint.name}  ${sprint.start} → ${sprint.finish}  ${sprint.closed ? 'closed' : 'active'}  (id ${sprint.id})`);
    if (sprint.stories.length === 0) lines.push('    (no stories)');
    for (const story of sprint.stories) lines.push(`    #${story.ref} ${story.subject}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The sprint of `milestones` named `name` exactly, or undefined. */
function findSprint(milestones: TaigaMilestone[], name: string): TaigaMilestone | undefined {
  return milestones.find((milestone) => milestone.name === name);
}

/**
 * Plans creating sprint `name` from `start` to `finish` in `slug`: `skip` when a sprint has that name and those days,
 * a SprintError when it has that name and other days (it is never changed).
 */
export async function planSprintCreate(client: TaigaClient, slug: string, sprint: { name: string; start: string; finish: string }): Promise<SprintCreatePlan> {
  const project = await client.getProjectBySlug(slug);
  const existing = findSprint(await client.listMilestones(project.id), sprint.name);
  if (existing && (existing.start !== sprint.start || existing.finish !== sprint.finish)) {
    throw new SprintError(
      `sprint "${sprint.name}" of ${slug} already exists from ${existing.start} to ${existing.finish} (id ${existing.id}), not ${sprint.start} to ${sprint.finish}; ` +
        'taigent never changes an existing sprint: pick another name, or change its days on Taiga',
    );
  }
  const operations: SprintCreateOperation[] = [{ action: existing ? 'skip' : 'create', ...sprint, id: existing?.id ?? null }];
  return { project: sprintProject(project), operations, ...summarize(CREATE_ACTIONS, operations) };
}

/** Runs a create plan; the report has each operation with its result and id. */
export async function executeSprintCreate(plan: SprintCreatePlan, client: TaigaClient) {
  const operations = [];
  for (const op of plan.operations) {
    if (op.action === 'skip') {
      operations.push({ ...op, result: 'unchanged' as const });
      continue;
    }
    const created = await client.createMilestone({ project: plan.project.id, name: op.name, estimated_start: op.start, estimated_finish: op.finish });
    operations.push({ ...op, id: created.id, result: 'created' as const });
  }
  return { project: plan.project, operations, summary: tally(CREATE_ACTIONS, plan.operations) };
}

export function describeSprintCreateOperation(op: SprintCreateOperation): string {
  return `sprint "${op.name}" ${op.start} → ${op.finish}${op.id === null ? '' : `  (id ${op.id})`}`;
}

/**
 * Plans putting the user stories `refs` of `slug` into sprint `name`: `skip` for a story already in it. An unknown
 * sprint or a ref that is no user story of the project is a SprintError, before anything is written.
 */
export async function planSprintAdd(client: TaigaClient, slug: string, name: string, refs: number[]): Promise<SprintAddPlan> {
  const project = await client.getProjectBySlug(slug);
  const [milestones, stories] = await Promise.all([client.listMilestones(project.id), client.listStories(project.id)]);
  const sprint = findSprint(milestones, name);
  if (!sprint) {
    const known = milestones.map((milestone) => `"${milestone.name}"`).join(', ');
    throw new SprintError(`no sprint named "${name}" in ${slug}${known ? `; its sprints: ${known}` : ' (it has no sprint; create one with taigent sprint create)'}`);
  }
  const byRef = new Map(stories.map((story) => [story.ref, story]));
  const missing = refs.filter((ref) => !byRef.has(ref));
  if (missing.length > 0) throw new SprintError(`not a user story of ${slug}: ${missing.map((ref) => `#${ref}`).join(', ')}; nothing was written`);
  const names = new Map(milestones.map((milestone) => [milestone.id, milestone.name]));
  const operations = [...new Set(refs)].map((ref): SprintAddOperation => {
    const story: TaigaStory = byRef.get(ref)!;
    return {
      action: story.milestone === sprint.id ? 'skip' : 'update',
      ref,
      id: story.id,
      subject: story.subject,
      from: story.milestone === null ? null : { id: story.milestone, name: names.get(story.milestone) ?? `id ${story.milestone}` },
      version: story.version,
    };
  });
  return { project: sprintProject(project), sprint: { id: sprint.id, name: sprint.name }, operations, ...summarize(ADD_ACTIONS, operations) };
}

/** Runs an add plan in order (PATCH with each story's version, OCC); a conflict names the story's ref. */
export async function executeSprintAdd(plan: SprintAddPlan, client: TaigaClient) {
  const operations = [];
  for (const op of plan.operations) {
    if (op.action === 'update') {
      try {
        await client.editStory(op.id, { milestone: plan.sprint.id }, op.version);
      } catch (error) {
        if (error instanceof TaigaConflictError) throw new TaigaConflictError(error.message, `#${op.ref}`);
        throw error;
      }
    }
    operations.push({ ...op, result: op.action === 'update' ? ('updated' as const) : ('unchanged' as const) });
  }
  return { project: plan.project, sprint: plan.sprint, operations, summary: tally(ADD_ACTIONS, plan.operations) };
}

export function describeSprintAddOperation(op: SprintAddOperation): string {
  return `story #${op.ref} ${op.subject}${op.action === 'update' && op.from ? `  (from sprint "${op.from.name}")` : ''}`;
}

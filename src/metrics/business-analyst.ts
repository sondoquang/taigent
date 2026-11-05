// The `businessAnalyst` section of `taigent metrics` (GLOSSARY.md, Dashboards): the user stories on Taiga by status,
// the requirement changes of each period (from each story's Taiga history), and from the backlog manifest and
// review.yaml (the preview, backlog.ts): complete acceptance criteria, requirements coverage, the items awaiting review
// and those pending clarification. Without a valid backlog manifest only the statuses and requirement changes remain;
// the metrics of the manifest are unavailable, with why.

import { localDay } from '../days.ts';
import type { ItemType } from '../items.ts';
import type { Scenario } from '../manifest/backlog.ts';
import type { Preview, PreviewItem, PreviewStory, ReviewComment } from '../review.ts';
import type { TaigaHistoryEntry, TaigaStatus } from '../taiga/client.ts';
import type { MetricsContext, UnavailableMetric } from './context.ts';
import { inPeriod, type Period } from './periods.ts';
import type { WorkItem } from './work.ts';

/** How many of the project's user stories are in one status, in the project's order of statuses. */
export interface StatusCount {
  status: string;
  closed: boolean;
  count: number;
}

/** A backlog item, by its manifest key. */
export interface BacklogRef {
  type: ItemType;
  key: string;
  subject: string;
  /** Its ref on Taiga, from state.json; null while the item is new. */
  ref: number | null;
}

export type ScenarioPart = 'given' | 'when' | 'then';

/** A backlog story without complete acceptance criteria, and why. */
export interface IncompleteStory extends BacklogRef {
  /** Key of its epic. */
  epic: string;
  /** `incomplete-scenarios`: every scenario misses its Given, When or Then (`scenarios` says which). */
  reason: 'legacy' | 'no-scenario' | 'incomplete-scenarios';
  scenarios: { scenario: string; missing: ScenarioPart[] }[];
}

export interface AwaitingReview extends BacklogRef {
  /** `unreviewed`: no verdict; `stale`: a verdict given before the item last changed. */
  reason: 'unreviewed' | 'stale';
}

export interface PendingClarification extends BacklogRef {
  /** Its open review comments. */
  comments: Pick<ReviewComment, 'id' | 'by' | 'at' | 'text'>[];
}

/** The Requirement changes (GLOSSARY.md) of one period: edits of a story's description after it first reached Ready. */
export interface RequirementChangeEntry {
  period: string;
  /** Description edits in the period. */
  changes: number;
  /** The stories edited, by ref, with their edits in the period. */
  stories: { ref: number; subject: string; changes: number }[];
}

/** The metrics of the backlog manifest are absent without a valid one (see `unavailable`). */
export interface BusinessAnalystMetrics {
  /** `notApplied`: the backlog's stories that are not on Taiga (new, or their recorded story is gone). */
  statuses: { stories: StatusCount[]; notApplied?: number };
  /** One per period, in the order of the report's `periods`. */
  requirementChange: RequirementChangeEntry[];
  /** `rate`: complete over stories, null without any story. */
  acceptanceCriteria?: { stories: number; complete: number; rate: number | null; incomplete: IncompleteStory[] };
  /** `rate`: covered over epics, null without any epic. */
  requirementsCoverage?: { epics: number; covered: number; rate: number | null; uncovered: BacklogRef[] };
  awaitingReview?: AwaitingReview[];
  pendingClarification?: PendingClarification[];
}

/** The JSON paths of the metrics that need the backlog manifest. */
const MANIFEST_METRICS = [
  'businessAnalyst.statuses.notApplied',
  'businessAnalyst.acceptanceCriteria',
  'businessAnalyst.requirementsCoverage',
  'businessAnalyst.awaitingReview',
  'businessAnalyst.pendingClarification',
];

/** Every status of the project, in its order, then any other status a story is in. */
function storyStatuses({ snapshot, work }: MetricsContext): StatusCount[] {
  const counts = new Map<string, StatusCount>(snapshot.statuses.story.map((status) => [status.name, { status: status.name, closed: status.isClosed, count: 0 }]));
  for (const story of work.filter((item) => item.type === 'story')) {
    const entry = counts.get(story.status) ?? { status: story.status, closed: story.closed, count: 0 };
    entry.count += 1;
    counts.set(story.status, entry);
  }
  return [...counts.values()];
}

/** The story status after which a description edit is a Requirement change (GLOSSARY.md). */
const READY = 'Ready';

/**
 * The local days of a story's Requirement changes: the description edits after the entry where it first reached
 * Ready, or every one when it was in Ready from its creation (its first status change leaves Ready, or it has none and
 * is in Ready). An edit saved with the move into Ready is not one. A status goes by its name in the project's list
 * (by id; the history may name it in another language), and by the history's name for a status no longer in it.
 */
function requirementChangeDays(history: TaigaHistoryEntry[], statusId: number | null, statuses: Map<number, TaigaStatus>): string[] {
  const isReady = (status: { id: number; name: string | null } | null) => status !== null && (statuses.get(status.id)?.name ?? status.name) === READY;
  const moves = history.flatMap((entry, index) => (entry.status ? [{ index, ...entry.status }] : []));
  const readySinceCreation = moves.length === 0 ? statusId !== null && statuses.get(statusId)?.name === READY : isReady(moves[0]!.from);
  const after = readySinceCreation ? -1 : moves.find((move) => isReady(move.to))?.index;
  if (after === undefined) return [];
  return history.flatMap((entry, index) => (index > after && entry.description ? [localDay(new Date(entry.at))] : []));
}

function requirementChange({ snapshot, periods }: MetricsContext): RequirementChangeEntry[] {
  const statuses = new Map(snapshot.statuses.story.map((status) => [status.id, status]));
  const edited = [...snapshot.stories]
    .sort((a, b) => a.ref - b.ref)
    .map((story) => ({ story, days: requirementChangeDays(snapshot.history.story.get(story.id) ?? [], story.statusId, statuses) }));
  return periods.map((period) => {
    const stories = edited.flatMap(({ story, days }) => {
      const changes = days.filter((day) => inPeriod(day, period)).length;
      return changes === 0 ? [] : [{ ref: story.ref, subject: story.subject, changes }];
    });
    return { period: period.id, changes: stories.reduce((sum, { changes }) => sum + changes, 0), stories };
  });
}

function backlogRef(item: PreviewItem): BacklogRef {
  return { type: item.type, key: item.key, subject: item.subject, ref: item.applied?.ref ?? null };
}

const blank = (text: string) => text.trim() === '';

function missingParts(scenario: Scenario): ScenarioPart[] {
  const missing: ScenarioPart[] = [];
  if (scenario.given.every(blank)) missing.push('given');
  if (blank(scenario.when)) missing.push('when');
  if (blank(scenario.then)) missing.push('then');
  return missing;
}

/** Why `story` has no complete acceptance criteria (GLOSSARY.md), or undefined when it has. */
function incompleteness(story: PreviewStory): Pick<IncompleteStory, 'reason' | 'scenarios'> | undefined {
  if (story.format === 'legacy') return { reason: 'legacy', scenarios: [] };
  if (story.scenarios.length === 0) return { reason: 'no-scenario', scenarios: [] };
  const scenarios = story.scenarios.map((scenario) => ({ scenario: scenario.scenario, missing: missingParts(scenario) }));
  return scenarios.some(({ missing }) => missing.length === 0) ? undefined : { reason: 'incomplete-scenarios', scenarios };
}

const rate = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000);

function manifestMetrics(preview: Preview, work: WorkItem[]): Required<Omit<BusinessAnalystMetrics, 'statuses' | 'requirementChange'>> & { notApplied: number } {
  const onTaiga = new Set(work.filter((item) => item.type === 'story').map((story) => story.id));
  const stories = preview.epics.flatMap((epic) => epic.stories.map((story) => ({ epic, story, incomplete: incompleteness(story) })));
  const incomplete = stories.flatMap(({ epic, story, incomplete }) => (incomplete ? [{ ...backlogRef(story), epic: epic.key, ...incomplete }] : []));
  const complete = new Set(stories.filter(({ incomplete }) => incomplete === undefined).map(({ story }) => story.key));
  const uncovered = preview.epics.filter((epic) => !epic.stories.some((story) => complete.has(story.key)));
  // Every item in manifest order: each epic, its stories and their tasks, then the issues.
  const items = [...preview.epics.flatMap((epic) => [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])]), ...preview.issues];
  return {
    notApplied: stories.filter(({ story }) => story.applied === undefined || !onTaiga.has(story.applied.id)).length,
    acceptanceCriteria: { stories: stories.length, complete: complete.size, rate: rate(complete.size, stories.length), incomplete },
    requirementsCoverage: {
      epics: preview.epics.length,
      covered: preview.epics.length - uncovered.length,
      rate: rate(preview.epics.length - uncovered.length, preview.epics.length),
      uncovered: uncovered.map(backlogRef),
    },
    awaitingReview: items
      .filter((item) => item.review.verdict === undefined || item.review.stale)
      .map((item) => ({ ...backlogRef(item), reason: item.review.verdict === undefined ? 'unreviewed' : 'stale' })),
    pendingClarification: items
      .filter((item) => item.review.openComments > 0)
      .map((item) => ({
        ...backlogRef(item),
        comments: item.review.comments.filter((comment) => !comment.resolved).map(({ id, by, at, text }) => ({ id, by, at, text })),
      })),
  };
}

export function businessAnalystMetrics(context: MetricsContext): BusinessAnalystMetrics {
  const { local, snapshot, notes } = context;
  const statuses = storyStatuses(context);
  const changes = requirementChange(context);
  const { backlog } = local;
  if (backlog.status === 'ok') {
    const { notApplied, ...metrics } = manifestMetrics(backlog.preview, context.work);
    return { statuses: { stories: statuses, notApplied }, requirementChange: changes, ...metrics };
  }
  let reason: UnavailableMetric['reason'];
  let message: string;
  if (backlog.status === 'missing') {
    reason = 'backlog-missing';
    message = `needs the backlog manifest ${backlog.file}, which does not exist`;
  } else {
    const [first] = backlog.issues;
    const issue = first ? `${first.file}${first.path ? `: ${first.path}` : ''}: ${first.message} [${first.rule}]` : 'invalid';
    const more = backlog.issues.length > 1 ? ` (and ${backlog.issues.length - 1} more)` : '';
    reason = 'backlog-invalid';
    message = `needs valid manifests and review.yaml; run \`taigent validate --project ${snapshot.project.slug}\`: ${issue}${more}`;
  }
  notes.warnings.push({ code: reason, message: `the metrics of the backlog manifest are unavailable: ${message}` });
  for (const metric of MANIFEST_METRICS) notes.unavailable.push({ metric, reason, message });
  return { statuses: { stories: statuses }, requirementChange: changes };
}

const percent = (value: number | null) => (value === null ? '' : ` (${Math.round(value * 100)}%)`);

const PART_NAMES: Record<ScenarioPart, string> = { given: 'Given', when: 'When', then: 'Then' };

function describeIncomplete(story: IncompleteStory): string {
  const why =
    story.reason === 'legacy'
      ? 'legacy format'
      : story.reason === 'no-scenario'
        ? 'no scenario'
        : story.scenarios.map(({ scenario, missing }) => `"${scenario}" missing ${missing.map((part) => PART_NAMES[part]).join(', ')}`).join('; ');
  return `    ${story.key} ${story.subject}: ${why}`;
}

/** The businessAnalyst section in text form. */
export function formatBusinessAnalystText(ba: BusinessAnalystMetrics, periods: Period[]): string[] {
  const statuses = ba.statuses.stories.map(({ status, count }) => `${status} ${count}`).join(', ') || 'none';
  const notApplied = ba.statuses.notApplied === undefined ? '' : `; not applied ${ba.statuses.notApplied}`;
  const lines = ['Business Analyst:', `  Stories by status: ${statuses}${notApplied}`];
  lines.push('  Requirement changes (story description edits after Ready):');
  ba.requirementChange.forEach(({ changes, stories }, index) => {
    const period = periods[index]!;
    lines.push(`    ${period.name}${period.current ? ' (current)' : ''}: ${changes} edit${changes === 1 ? '' : 's'} of ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'}`);
  });
  const { acceptanceCriteria: criteria, requirementsCoverage: coverage, awaitingReview, pendingClarification } = ba;
  if (criteria) {
    lines.push(`  Complete acceptance criteria: ${criteria.complete} of ${criteria.stories} stories${percent(criteria.rate)}`);
    lines.push(...criteria.incomplete.map(describeIncomplete));
  }
  if (coverage) {
    lines.push(`  Requirements coverage: ${coverage.covered} of ${coverage.epics} epics${percent(coverage.rate)}`);
    lines.push(...coverage.uncovered.map((epic) => `    ${epic.key} ${epic.subject}`));
  }
  if (awaitingReview) {
    lines.push(`  Awaiting review (${awaitingReview.length}):`);
    lines.push(...awaitingReview.map((item) => `    ${item.type} ${item.key} ${item.subject} (${item.reason === 'stale' ? 'stale verdict' : 'not reviewed'})`));
  }
  if (pendingClarification) {
    lines.push(`  Pending clarification (${pendingClarification.length}):`);
    for (const item of pendingClarification) {
      lines.push(`    ${item.type} ${item.key} ${item.subject}`, ...item.comments.map((comment) => `      ${comment.by}: ${comment.text}`));
    }
  }
  return lines;
}

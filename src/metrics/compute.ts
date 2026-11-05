// `taigent metrics`: every metric of the dashboards (GLOSSARY.md, Dashboards) from one snapshot of a project. Pure:
// no network, no files. Each Role's section lives in its own module and adds its own warnings and unavailable
// metrics to the context's notes.

import { localDay } from '../days.ts';
import { type BugTrendEntry, bugMetrics, type DeveloperBugs } from './bugs.ts';
import { HISTORY_UNAVAILABLE, type MetricsContext, type MetricsLocal, type MetricsWarning, type UnavailableMetric } from './context.ts';
import { type DeveloperMetrics, developerMetrics } from './developer.ts';
import { type Cadence, type Period, sprintPeriods, weekPeriods } from './periods.ts';
import { type ReleaseBurndown, releaseBurndown } from './releases.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import { workItems } from './work.ts';

export interface MetricsReport {
  project: { id: number; slug: string; name: string };
  generatedAt: string;
  /** YYYY-MM-DD, local time zone. */
  today: string;
  cadence: Cadence;
  /** Oldest first, ending with the current period. */
  periods: Period[];
  developer: DeveloperMetrics & { bugs: DeveloperBugs };
  productOwner: { bugTrend: BugTrendEntry[]; releaseBurndown: ReleaseBurndown };
  warnings: MetricsWarning[];
  unavailable: UnavailableMetric[];
}

/** Metrics of sections still to come that need the Taiga history of each item; each moves into its section. */
const NEED_HISTORY = [
  'developer.bugs.reopenRate',
  'productOwner.planned.sprintStart',
  'productOwner.scopeChange',
  'productOwner.bugTrend.reopened',
  'businessAnalyst.requirementChange',
];

export function computeMetrics(snapshot: MetricsSnapshot, local: MetricsLocal, now: Date): MetricsReport {
  const today = localDay(now);
  const cadence: Cadence = snapshot.project.sprints ? 'sprint' : 'week';
  const context: MetricsContext = {
    snapshot,
    local,
    today,
    cadence,
    periods: cadence === 'sprint' ? sprintPeriods(snapshot.sprints, today) : weekPeriods(today),
    work: workItems(snapshot),
    notes: { warnings: [], unavailable: [] },
  };
  if (cadence === 'week') {
    context.notes.warnings.push({ code: 'kanban', message: 'the Backlog module (sprints) is off: periods are weeks, Monday to Sunday, and there are no sprint metrics' });
  }
  const developer = developerMetrics(context);
  const bugs = bugMetrics(context);
  const burndown = releaseBurndown(context);
  for (const metric of NEED_HISTORY) context.notes.unavailable.push({ metric, reason: 'history', message: HISTORY_UNAVAILABLE });
  const { id, slug, name } = snapshot.project;
  return {
    project: { id, slug, name },
    generatedAt: now.toISOString(),
    today,
    cadence,
    periods: context.periods,
    developer: { ...developer, bugs: bugs.developer },
    productOwner: { bugTrend: bugs.bugTrend, releaseBurndown: burndown },
    warnings: context.notes.warnings,
    unavailable: context.notes.unavailable,
  };
}

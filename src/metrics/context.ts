// What every section of `taigent metrics` (developer, …) computes from, and where it reports what it could not
// compute: one `MetricsContext` per run, built by compute.ts.

import type { ReleaseSpec } from '../manifest/project.ts';
import type { BacklogData } from './backlog.ts';
import type { Cadence, Period } from './periods.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import type { WorkItem } from './work.ts';

/**
 * Something the reader should know about the figures: why sprint metrics are missing (`kanban`), a release tag
 * not declared in project.yaml, a declared release without stories, a story with two release tags or more, or why the
 * backlog manifest's metrics are missing (`backlog-missing`, `backlog-invalid`).
 */
export interface MetricsWarning {
  code: 'kanban' | 'release-undeclared' | 'release-empty' | 'release-multiple' | 'backlog-missing' | 'backlog-invalid';
  message: string;
}

/** A metric the run could not compute, and why: `backlog-missing` / `backlog-invalid`, it needs the project's backlog manifest, absent or invalid. */
export interface UnavailableMetric {
  /** Its path in the JSON, e.g. `businessAnalyst.acceptanceCriteria`. */
  metric: string;
  reason: 'backlog-missing' | 'backlog-invalid';
  message: string;
}

/** What metrics reads from the repository rather than Taiga. */
export interface MetricsLocal {
  /** The releases of project.yaml (ADR 0005); none when the project has no project.yaml. */
  releases: ReleaseSpec[];
  /** The preview of the backlog manifest and review.yaml (backlog.ts), or why there is none. */
  backlog: BacklogData;
}

export interface MetricsContext {
  snapshot: MetricsSnapshot;
  local: MetricsLocal;
  /** YYYY-MM-DD, local time zone. */
  today: string;
  cadence: Cadence;
  periods: Period[];
  work: WorkItem[];
  /** Each section adds its own warnings and unavailable metrics. */
  notes: { warnings: MetricsWarning[]; unavailable: UnavailableMetric[] };
}

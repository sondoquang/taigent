// What every section of `taigent metrics` (developer, …) computes from, and where it reports what it could not
// compute: one `MetricsContext` per run, built by compute.ts.

import type { BacklogData } from './backlog.ts';
import type { Cadence, Period } from './periods.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import type { WorkItem } from './work.ts';

/**
 * Something the reader should know about the figures: why sprint metrics are missing (`kanban`), why the backlog
 * manifest's metrics are (`backlog-missing`, `backlog-invalid`).
 */
export interface MetricsWarning {
  code: 'kanban' | 'backlog-missing' | 'backlog-invalid';
  message: string;
}

/**
 * A metric the run could not compute, and why: `history`, it needs the Taiga history of each item;
 * `backlog-missing` / `backlog-invalid`, it needs the project's backlog manifest, absent or invalid.
 */
export interface UnavailableMetric {
  /** Its path in the JSON, e.g. `developer.cycleTime`. */
  metric: string;
  reason: 'history' | 'backlog-missing' | 'backlog-invalid';
  message: string;
}

export const HISTORY_UNAVAILABLE = 'needs the Taiga history of each item, which metrics does not read yet';

/** What the run read from the project's manifest directory, besides Taiga. */
export interface MetricsLocal {
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

// What every section of `taigent metrics` (developer, …) computes from, and where it reports what it could not
// compute: one `MetricsContext` per run, built by compute.ts.

import type { Cadence, Period } from './periods.ts';
import type { MetricsSnapshot } from './snapshot.ts';
import type { WorkItem } from './work.ts';

/** Something the reader should know about the figures, e.g. why sprint metrics are missing. */
export interface MetricsWarning {
  code: 'kanban';
  message: string;
}

/** A metric the run could not compute, and why (`history`: it needs the Taiga history of each item). */
export interface UnavailableMetric {
  /** Its path in the JSON, e.g. `developer.cycleTime`. */
  metric: string;
  reason: 'history';
  message: string;
}

export const HISTORY_UNAVAILABLE = 'needs the Taiga history of each item, which metrics does not read yet';

export interface MetricsContext {
  snapshot: MetricsSnapshot;
  /** YYYY-MM-DD, local time zone. */
  today: string;
  cadence: Cadence;
  periods: Period[];
  work: WorkItem[];
  /** Each section adds its own warnings and unavailable metrics. */
  notes: { warnings: MetricsWarning[]; unavailable: UnavailableMetric[] };
}

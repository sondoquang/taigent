// Reporting periods of `taigent metrics`: the sprints of a scrum project, or the weeks (Monday to Sunday, local
// time) of a kanban project, oldest first, ending with the current one.

import { addDays, mondayOf } from '../days.ts';
import type { TaigaMilestone } from '../taiga/client.ts';

/** `sprint` when the project's Backlog module is on, else `week`. */
export type Cadence = 'sprint' | 'week';

export interface Period {
  /** `sprint:<id>` or `week:<Monday>`. */
  id: string;
  name: string;
  /** First and last day, YYYY-MM-DD, inclusive. */
  start: string;
  finish: string;
  /** The open sprint holding today, or this week. */
  current: boolean;
}

/** How many periods the trends cover. */
export const PERIOD_COUNT = 6;

/** The last PERIOD_COUNT sprints that have started, by first day. */
export function sprintPeriods(sprints: TaigaMilestone[], today: string): Period[] {
  return sprints
    .filter((sprint) => sprint.start <= today)
    .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id)
    .slice(-PERIOD_COUNT)
    .map((sprint) => ({
      id: `sprint:${sprint.id}`,
      name: sprint.name,
      start: sprint.start,
      finish: sprint.finish,
      current: !sprint.closed && today <= sprint.finish,
    }));
}

/** The PERIOD_COUNT weeks up to the week holding today. */
export function weekPeriods(today: string): Period[] {
  const thisWeek = mondayOf(today);
  return Array.from({ length: PERIOD_COUNT }, (_, index) => {
    const start = addDays(thisWeek, (index + 1 - PERIOD_COUNT) * 7);
    return { id: `week:${start}`, name: `Week of ${start}`, start, finish: addDays(start, 6), current: start === thisWeek };
  });
}

/** Whether the calendar day `day` falls in `period`. */
export function inPeriod(day: string, period: Period): boolean {
  return period.start <= day && day <= period.finish;
}

// The sprint each user story was in over time, rebuilt from the milestone changes of its Taiga history: planned at
// sprint start (the points of the stories in a sprint on its first day) and scope change (GLOSSARY.md, Scope change:
// the stories added to or taken out of a sprint after its first day, up to its last). Days are local calendar days;
// points are each story's points now (Taiga's history of points is not read).

import { localDay } from '../days.ts';
import type { TaigaHistoryEntry, TaigaStory } from '../taiga/client.ts';
import type { Period } from './periods.ts';

/** A story added to or taken out of a sprint, on `day` (YYYY-MM-DD). */
export interface ScopeStory {
  id: number;
  ref: number;
  subject: string;
  /** Its points now; null when not estimated. */
  points: number | null;
  day: string;
}

export interface ScopeChange {
  /** `sprint:<id>`, one per sprint period, in the order of the report's `periods`. */
  period: string;
  /** Stories in order of day, then ref; `points` sums theirs. */
  added: { points: number; stories: ScopeStory[] };
  removed: { points: number; stories: ScopeStory[] };
}

/** One move of a story between sprints (null: in no sprint), on a local day. */
interface Move {
  day: string;
  from: number | null;
  to: number | null;
}

/**
 * A story's moves, oldest first: its milestone changes, and its creation when it was created in a sprint (Taiga
 * records no change for the sprint an item is created in: the sprint before the first change, or its sprint now).
 */
function movesOf(story: TaigaStory, history: TaigaHistoryEntry[]): Move[] {
  const changes = history.flatMap((entry) => (entry.milestone ? [{ day: localDay(new Date(entry.at)), ...entry.milestone }] : []));
  const initial = changes.length > 0 ? changes[0]!.from : story.milestone;
  const created = story.createdAt === null || initial === null ? [] : [{ day: localDay(new Date(story.createdAt)), from: null, to: initial }];
  return [...created, ...changes];
}

/** The sprint a story was in at the end of `day`: where its first later move came from, else its sprint now. */
function sprintAt(story: TaigaStory, moves: Move[], day: string): number | null {
  if (story.createdAt !== null && localDay(new Date(story.createdAt)) > day) return null;
  const next = moves.find((move) => move.day > day);
  return next ? next.from : story.milestone;
}

/** The stories in order of day, then ref, with the sum of their points. */
function side(stories: ScopeStory[]): ScopeChange['added'] {
  stories.sort((a, b) => a.day.localeCompare(b.day) || a.ref - b.ref);
  return { points: stories.reduce((total, story) => total + (story.points ?? 0), 0), stories };
}

export interface SprintScope {
  /** Points of the stories in the sprint at the end of its first day, by sprint id. */
  planned: Map<number, number>;
  scopeChange: ScopeChange[];
}

/** Planned at sprint start and scope change of every sprint period (`sprint:<id>`) in `periods`. */
export function sprintScope(stories: TaigaStory[], histories: Map<number, TaigaHistoryEntry[]>, periods: Period[]): SprintScope {
  const moved = stories.map((story) => ({ story, moves: movesOf(story, histories.get(story.id) ?? []) }));
  const planned = new Map<number, number>();
  const scopeChange = periods.map((period): ScopeChange => {
    const sprint = Number(period.id.slice('sprint:'.length));
    planned.set(sprint, moved.reduce((total, { story, moves }) => total + (sprintAt(story, moves, period.start) === sprint ? (story.totalPoints ?? 0) : 0), 0));
    const added: ScopeStory[] = [];
    const removed: ScopeStory[] = [];
    for (const { story, moves } of moved) {
      for (const move of moves) {
        if (move.day <= period.start || move.day > period.finish || move.from === move.to) continue;
        const entry = { id: story.id, ref: story.ref, subject: story.subject, points: story.totalPoints, day: move.day };
        if (move.to === sprint) added.push(entry);
        if (move.from === sprint) removed.push(entry);
      }
    }
    return { period: period.id, added: side(added), removed: side(removed) };
  });
  return { planned, scopeChange };
}

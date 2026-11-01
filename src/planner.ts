// Planner: pure function from (manifest, Taiga state read back) to an ordered plan. No I/O.

import type { Backlog } from './manifest/backlog.ts';
import type { ItemType } from './manifest/state.ts';
import type { TaigaEpic } from './taiga/client.ts';

/** Identity tag of a manifest item on Taiga. Lowercase because Taiga lowercases every tag it stores. */
export function srcTag(key: string): string {
  return `src:${key.toLowerCase()}`;
}

export interface PlanProject {
  id: number;
  slug: string;
}

export interface RemoteState {
  project: PlanProject;
  epics: TaigaEpic[];
}

export interface ItemFields {
  subject: string;
  description: string;
  tags: string[];
}

export type Operation =
  | { action: 'create'; type: ItemType; key: string; fields: ItemFields }
  | { action: 'skip'; type: ItemType; key: string; id: number; ref: number; version: number };

export type Action = Operation['action'];

export interface Plan {
  project: PlanProject;
  /** True when applying would write to Taiga. */
  changes: boolean;
  summary: Record<Action, number>;
  operations: Operation[];
}

export function buildPlan(backlog: Backlog, remote: RemoteState): Plan {
  const epicsByTag = new Map<string, TaigaEpic>();
  // Oldest first, so if duplicates already exist the original item keeps its identity.
  for (const epic of [...remote.epics].sort((a, b) => a.id - b.id)) {
    for (const tag of epic.tags) {
      if (tag.startsWith('src:') && !epicsByTag.has(tag)) epicsByTag.set(tag, epic);
    }
  }

  const operations: Operation[] = backlog.epics.map((epic): Operation => {
    const tag = srcTag(epic.key);
    const existing = epicsByTag.get(tag);
    if (existing) {
      return { action: 'skip', type: 'epic', key: epic.key, id: existing.id, ref: existing.ref, version: existing.version };
    }
    const tags = [...new Set([...epic.tags.map((t) => t.toLowerCase()), tag])];
    return { action: 'create', type: 'epic', key: epic.key, fields: { subject: epic.subject, description: epic.description, tags } };
  });

  const summary: Record<Action, number> = { create: 0, skip: 0 };
  for (const op of operations) summary[op.action] += 1;
  return { project: remote.project, changes: operations.some((op) => op.action !== 'skip'), summary, operations };
}

// The shape shared by the three plan → execute commands (`plan`/`apply`, `bootstrap`, `upload`): a plan is a list of
// operations, each with an action; its summary counts them and `changes` says whether executing would write to Taiga.
// Executing an operation yields a result, which the report counts the same way.

export type Action = 'create' | 'update' | 'adopt' | 'link' | 'skip';

/** The result of executing an operation with each action. */
export const RESULT = { create: 'created', update: 'updated', adopt: 'adopted', link: 'linked', skip: 'unchanged' } as const;
export type Result = (typeof RESULT)[Action];

/** The actions of a bootstrap or upload plan, which only fill gaps: create, update or skip (no links). */
export const FILL_ACTIONS = ['create', 'update', 'skip'] as const;
export type FillAction = (typeof FILL_ACTIONS)[number];
export type FillResult = (typeof RESULT)[FillAction];

export interface PlanSummary<A extends Action> {
  /** True when executing the plan would write to Taiga (any action but `skip`). */
  changes: boolean;
  summary: Record<A, number>;
}

/** Counts `operations` per action (every action of `actions`, zero included). */
export function summarize<A extends Action>(actions: readonly A[], operations: readonly { action: A }[]): PlanSummary<A> {
  const summary = Object.fromEntries(actions.map((action) => [action, 0])) as Record<A, number>;
  for (const op of operations) summary[op.action] += 1;
  return { changes: operations.some((op) => op.action !== 'skip'), summary };
}

/** Counts executed `operations` per result (every result of `actions`, zero included). */
export function tally<A extends Action>(actions: readonly A[], operations: readonly { action: A }[]): Record<(typeof RESULT)[A], number> {
  const counts = Object.fromEntries(actions.map((action) => [RESULT[action], 0])) as Record<(typeof RESULT)[A], number>;
  for (const op of operations) counts[RESULT[op.action]] += 1;
  return counts;
}

// Executor: runs a plan through the Taiga client in dependency order and records every item in the
// state file, writing it after each successful write to Taiga so a failed run can be resumed.

import { readState, writeState } from './manifest/state.ts';
import type { Operation, Plan, PlanProject } from './planner.ts';
import { TaigaError, type TaigaClient } from './taiga/client.ts';

export type OperationResult = 'created' | 'unchanged';

export interface AppliedOperation {
  action: Operation['action'];
  type: Operation['type'];
  key: string;
  id: number;
  ref: number;
  result: OperationResult;
}

export interface ApplyReport {
  project: PlanProject;
  operations: AppliedOperation[];
  summary: Record<OperationResult, number>;
}

export async function executePlan(plan: Plan, client: TaigaClient, statePath: string): Promise<ApplyReport> {
  const state = await readState(statePath, plan.project);
  const operations: AppliedOperation[] = [];
  const summary: Record<OperationResult, number> = { created: 0, unchanged: 0 };

  for (const op of plan.operations) {
    let applied: AppliedOperation;
    if (op.action === 'skip') {
      state.items[op.key] = { type: op.type, id: op.id, ref: op.ref, version: op.version };
      applied = { action: op.action, type: op.type, key: op.key, id: op.id, ref: op.ref, result: 'unchanged' };
    } else {
      let epic;
      try {
        epic = await client.createEpic({ project: plan.project.id, ...op.fields });
      } catch (error) {
        if (!(error instanceof TaigaError)) throw error;
        await writeState(statePath, state);
        throw new TaigaError(`create ${op.type} ${op.key} failed: ${error.message}`, error.status);
      }
      state.items[op.key] = { type: op.type, id: epic.id, ref: epic.ref, version: epic.version };
      await writeState(statePath, state);
      applied = { action: op.action, type: op.type, key: op.key, id: epic.id, ref: epic.ref, result: 'created' };
    }
    operations.push(applied);
    summary[applied.result] += 1;
  }

  // Final write also refreshes the cache when nothing was created (e.g. the state file had been deleted).
  await writeState(statePath, state);
  return { project: plan.project, operations, summary };
}

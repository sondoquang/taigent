// Executor: runs a plan through the Taiga client in dependency order and records every item in the
// state file, writing it after each successful write to Taiga so a failed run can be resumed.

import type { ItemType } from './items.ts';
import type { AttributeValue } from './manifest/backlog.ts';
import { readState, writeState, type StateFile } from './manifest/state.ts';
import type { Operation, Plan, PlanProject, RemoteState } from './planner.ts';
import { TaigaConflictError, TaigaError, type ItemPatch, type TaigaClient, type TaigaItem } from './taiga/client.ts';

export type OperationResult = 'created' | 'updated' | 'linked' | 'unchanged';

export interface AppliedOperation {
  action: Operation['action'];
  type: Operation['type'];
  key: string;
  id: number;
  ref: number;
  /** For `link`: key of the epic the story was linked to. */
  epic?: string;
  result: OperationResult;
}

export interface ApplyReport {
  project: PlanProject;
  operations: AppliedOperation[];
  summary: Record<OperationResult, number>;
}

/** An update refused by Taiga's OCC check: the item changed on Taiga after the plan read it. */
export class ApplyConflictError extends TaigaConflictError {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.key = key;
  }
}

/** Id of an item recorded earlier in this run (parents always precede their children in a plan). */
function recordedId(state: StateFile, key: string): number {
  const entry = state.items[key];
  if (!entry) throw new Error(`executor: ${key} has not been recorded before it is referenced`);
  return entry.id;
}

function create(op: Extract<Operation, { action: 'create' }>, plan: Plan, state: StateFile, client: TaigaClient): Promise<TaigaItem> {
  const item = { project: plan.project.id, ...op.fields };
  return client.createItem(op.type, op.type === 'task' ? { ...item, user_story: recordedId(state, op.parent!) } : item);
}

/** PATCHes the changed item fields; an update of custom attribute values alone leaves the item untouched. */
async function update(op: Extract<Operation, { action: 'update' }>, client: TaigaClient): Promise<Pick<TaigaItem, 'id' | 'ref' | 'version'>> {
  const { custom_attributes: _attributes, ...fields } = op.changes;
  if (Object.keys(fields).length === 0) return op;
  const patch: ItemPatch = Object.fromEntries(Object.entries(fields).map(([field, change]) => [field, change.to]));
  return client.updateItem(op.type, op.id, patch, op.version);
}

/**
 * Sets custom attribute values (by name) on an item. Taiga replaces the whole values object on PATCH, so the
 * current values are read first and kept. `version` defaults to the one just read (new items).
 */
async function writeAttributes(
  type: ItemType,
  itemId: number,
  values: Record<string, AttributeValue>,
  version: number | undefined,
  attributes: RemoteState['customAttributes'],
  client: TaigaClient,
): Promise<void> {
  const current = await client.getAttributeValues(type, itemId);
  const merged = { ...current.values };
  for (const [name, value] of Object.entries(values)) {
    const attribute = attributes[type].find((a) => a.name === name);
    if (!attribute) throw new Error(`executor: custom attribute "${name}" was not planned for ${type}s`);
    merged[String(attribute.id)] = value;
  }
  await client.updateAttributeValues(type, itemId, merged, version ?? current.version);
}

/** `attributes`: the project's custom attributes, to resolve the attribute names of the plan to ids. */
export async function executePlan(plan: Plan, client: TaigaClient, statePath: string, attributes: RemoteState['customAttributes']): Promise<ApplyReport> {
  const state = await readState(statePath, plan.project);
  const operations: AppliedOperation[] = [];
  const summary: Record<OperationResult, number> = { created: 0, updated: 0, linked: 0, unchanged: 0 };

  for (const op of plan.operations) {
    let applied: AppliedOperation;
    if (op.action === 'skip') {
      state.items[op.key] = { type: op.type, id: op.id, ref: op.ref, version: op.version };
      applied = { action: op.action, type: op.type, key: op.key, id: op.id, ref: op.ref, result: 'unchanged' };
    } else {
      try {
        if (op.action === 'link') {
          const story = state.items[op.key]!;
          await client.linkEpicUserStory(recordedId(state, op.epic), story.id);
          applied = { action: op.action, type: op.type, key: op.key, id: story.id, ref: story.ref, epic: op.epic, result: 'linked' };
        } else {
          const item = op.action === 'create' ? await create(op, plan, state, client) : await update(op, client);
          state.items[op.key] = { type: op.type, id: item.id, ref: item.ref, version: item.version };
          const values = op.action === 'create' ? op.custom_attributes : op.changes.custom_attributes?.to;
          const valuesVersion = op.action === 'update' ? op.changes.custom_attributes?.version : undefined;
          if (values) await writeAttributes(op.type, item.id, values, valuesVersion, attributes, client);
          applied = { action: op.action, type: op.type, key: op.key, id: item.id, ref: item.ref, result: op.action === 'create' ? 'created' : 'updated' };
        }
      } catch (error) {
        if (!(error instanceof TaigaError)) throw error;
        await writeState(statePath, state);
        const what = op.action === 'link' ? `link story ${op.key} to epic ${op.epic}` : `${op.action} ${op.type} ${op.key}`;
        if (error instanceof TaigaConflictError) {
          throw new ApplyConflictError(op.key, `${what}: version conflict, ${op.key} was changed on Taiga by someone else after it was read; nothing was overwritten. Re-run plan to review.`);
        }
        throw new TaigaError(`${what} failed: ${error.message}`, error.status);
      }
      await writeState(statePath, state);
    }
    operations.push(applied);
    summary[applied.result] += 1;
  }

  // Final write also refreshes the cache when nothing was created (e.g. the state file had been deleted).
  await writeState(statePath, state);
  return { project: plan.project, operations, summary };
}

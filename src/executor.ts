// Executor: runs a plan through the Taiga client in dependency order and records every item, with its baseline, in
// the state file, writing it after each successful write to Taiga so a failed run can be resumed.

import type { ItemType } from './items.ts';
import type { AttributeValue } from './manifest/backlog.ts';
import type { ManagedValues } from './managed.ts';
import { readState, writeState, type StateFile } from './manifest/state.ts';
import { RESULT, tally, type Result } from './operations.ts';
import { PLAN_ACTIONS, type Operation, type Plan, type PlanProject, type PlannedBacklog, type RemoteState } from './planner.ts';
import { TaigaConflictError, TaigaError, type ItemPatch, type TaigaClient, type TaigaItem } from './taiga/client.ts';

export interface AppliedOperation {
  action: Operation['action'];
  type: Operation['type'];
  key: string;
  id: number;
  ref: number;
  /** For `link`: key of the epic the story was linked to. */
  epic?: string;
  result: Result;
}

export interface ApplyReport {
  project: PlanProject;
  operations: AppliedOperation[];
  summary: Record<Result, number>;
}

/** Human-readable description of an applied operation, for the text form of the report. */
export function describeAppliedOperation(op: AppliedOperation): string {
  return op.action === 'link' ? `story ${op.key} -> epic ${op.epic}` : `${op.type} ${op.key}  #${op.ref} (id ${op.id})`;
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

/**
 * PATCHes the changed item fields (a moved task: `user_story` = its manifest parent, recorded earlier in the run);
 * an update of custom attribute values alone leaves the item untouched. An adopt PATCHes its tags (`src:<key>` added)
 * and its content updates the same way.
 */
async function update(op: Extract<Operation, { action: 'update' | 'adopt' }>, state: StateFile, client: TaigaClient): Promise<Pick<TaigaItem, 'id' | 'ref' | 'version'>> {
  const { custom_attributes: _attributes, parent, ...fields } = op.changes;
  const patch: ItemPatch = Object.fromEntries(Object.entries(fields).map(([field, change]) => [field, change.to]));
  if (parent) patch.user_story = recordedId(state, parent.to);
  if (Object.keys(patch).length === 0) return op;
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

/**
 * `baselines`: what to record for each item once its operation succeeded. `attributes`: the project's custom
 * attributes, to resolve the attribute names of the plan to ids.
 */
export async function executePlan({ plan, baselines }: PlannedBacklog, client: TaigaClient, statePath: string, attributes: RemoteState['customAttributes']): Promise<ApplyReport> {
  const state = await readState(statePath, plan.project);
  const operations: AppliedOperation[] = [];

  for (const op of plan.operations) {
    let applied: AppliedOperation;
    if (op.action === 'skip') {
      state.items[op.key] = { type: op.type, id: op.id, ref: op.ref, version: op.version, baseline: baselines.get(op.key)! };
      applied = { action: op.action, type: op.type, key: op.key, id: op.id, ref: op.ref, result: RESULT[op.action] };
    } else {
      try {
        if (op.action === 'link') {
          const story = state.items[op.key]!;
          await client.linkEpicUserStory(recordedId(state, op.epic), story.id);
          if (story.baseline?.epics && !story.baseline.epics.includes(op.epic)) story.baseline.epics.push(op.epic);
          applied = { action: op.action, type: op.type, key: op.key, id: story.id, ref: story.ref, epic: op.epic, result: RESULT[op.action] };
        } else {
          const item = op.action === 'create' ? await create(op, plan, state, client) : await update(op, state, client);
          const baseline = baselines.get(op.key)!;
          const values = op.action === 'create' ? op.custom_attributes : op.changes.custom_attributes?.to;
          // Until the attribute values are written, the baseline keeps those Taiga still holds (unset on a new item).
          const before: ManagedValues['custom_attributes'] = op.action === 'create' ? {} : { ...baseline.custom_attributes, ...op.changes.custom_attributes?.from } as ManagedValues['custom_attributes'];
          state.items[op.key] = { type: op.type, id: item.id, ref: item.ref, version: item.version, baseline: values ? { ...baseline, custom_attributes: before } : baseline };
          if (op.action === 'adopt') delete state.adopted[op.key];
          const valuesVersion = op.action === 'create' ? undefined : op.changes.custom_attributes?.version;
          if (values) {
            await writeAttributes(op.type, item.id, values, valuesVersion, attributes, client);
            state.items[op.key]!.baseline = baseline;
          }
          applied = { action: op.action, type: op.type, key: op.key, id: item.id, ref: item.ref, result: RESULT[op.action] };
        }
      } catch (error) {
        if (!(error instanceof TaigaError)) throw error;
        await writeState(statePath, state);
        const what = op.action === 'link' ? `link story ${op.key} to epic ${op.epic}` : `${op.action} ${op.type} ${op.key}`;
        if (error instanceof TaigaConflictError) {
          throw new TaigaConflictError(`${what}: version conflict, ${op.key} was changed on Taiga by someone else after it was read; nothing was overwritten. Re-run plan to review.`, op.key);
        }
        throw new TaigaError(`${what} failed: ${error.message}`, error.status);
      }
      await writeState(statePath, state);
    }
    operations.push(applied);
  }

  // Final write also refreshes the cache when nothing was created (e.g. the state file had been deleted).
  await writeState(statePath, state);
  return { project: plan.project, operations, summary: tally(PLAN_ACTIONS, operations) };
}

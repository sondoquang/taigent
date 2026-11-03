// Pull: brings Taiga's managed values of backlog items into backlog.yaml and records them as the items' baseline in
// state.json, so a remote edit stops blocking plan (ADR 0004: Taiga is the truth, the manifest a draft of changes not
// applied yet). Reads Taiga through the plan, writes only local files. A story keeps its format: its description is
// parsed back from the story template, and one that does not parse changes no file. `keepManifest` only moves the
// baseline to Taiga's values, so the next plan proposes writing the manifest's values: the way to settle a conflict,
// an unknown item or a deliberate overwrite.

import { readManifestFile, saveItems, type BacklogItem, type IssueFields, type ItemFields, type StoryFields } from './edit.ts';
import { ISSUE_VALUE_FIELDS, type ItemType } from './items.ts';
import type { AttributeValue, Backlog, EpicSpec, IssueSpec, StorySpec, TaskSpec } from './manifest/backlog.ts';
import { ManifestError } from './manifest/errors.ts';
import type { ProjectLayout } from './manifest/layout.ts';
import { readState, writeState } from './manifest/state.ts';
import { differingFields, type ManagedField } from './managed.ts';
import type { BlockedKind, Counterpart, PlannedBacklog, PlanProject } from './planner.ts';
import { parseStoryDescription } from './story-template.ts';

/** `--key` names no backlog item, or one not on Taiga yet. Maps to a usage error; nothing was written. */
export class PullKeyError extends Error {}

/**
 * Taiga's values of an item cannot be written into backlog.yaml (a story description outside its template, a task in
 * no backlog story, …). Nothing was written. `description`: Taiga's raw description when it is the one at fault.
 */
export class PullError extends Error {
  readonly key: string;
  readonly description?: string;

  constructor(message: string, key: string, description?: string) {
    super(message);
    this.key = key;
    if (description !== undefined) this.description = description;
  }
}

export interface PullRequest {
  /** The backlog item to pull; absent: every item the plan blocks. */
  key?: string;
  /** Leave backlog.yaml as it is and only set the baseline to Taiga's values. */
  keepManifest: boolean;
}

/** One pulled item: `kind` why plan blocked it (null when it was not blocked), `fields` where Taiga and the manifest differed. */
export interface PulledItem {
  type: ItemType;
  key: string;
  id: number;
  ref: number;
  kind: BlockedKind | null;
  fields: ManagedField[];
}

/** What `taigent pull --json` prints. */
export interface PullReport {
  project: PlanProject;
  keepManifest: boolean;
  pulled: PulledItem[];
}

/** A backlog item where the manifest holds it. */
type Located =
  | { type: 'epic'; spec: EpicSpec }
  | { type: 'story'; spec: StorySpec; parent: string }
  | { type: 'task'; spec: TaskSpec; parent: string }
  | { type: 'issue'; spec: IssueSpec };

function locate(backlog: Backlog): Map<string, Located> {
  const located = new Map<string, Located>();
  for (const epic of backlog.epics) {
    located.set(epic.key, { type: 'epic', spec: epic });
    for (const story of epic.stories) {
      located.set(story.key, { type: 'story', spec: story, parent: epic.key });
      for (const task of story.tasks) located.set(task.key, { type: 'task', spec: task, parent: story.key });
    }
  }
  for (const issue of backlog.issues) located.set(issue.key, { type: 'issue', spec: issue });
  return located;
}

const SETTLE = 'settle it in backlog.yaml, then pull it with --keep-manifest so that apply writes the manifest';

/** The edit that writes Taiga's managed values of `item` into backlog.yaml, in the manifest's own shape. */
function pulledItem(item: Located, { taiga }: Counterpart, located: ReadonlyMap<string, Located>): BacklogItem {
  const { key } = item.spec;
  const customAttributes: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(taiga.custom_attributes)) {
    // Unset on Taiga: the manifest no longer declares it.
    if (value === null) continue;
    if (typeof value === 'object') throw new PullError(`${key}: custom attribute "${name}" holds ${JSON.stringify(value)} on Taiga, which backlog.yaml cannot hold; ${SETTLE}`, key);
    customAttributes[name] = value;
  }
  const fields: ItemFields = { subject: taiga.subject, description: taiga.description, tags: taiga.tags, customAttributes };
  switch (item.type) {
    case 'epic':
      return { type: 'epic', key, fields };
    case 'issue': {
      const issueFields: IssueFields = { ...fields };
      for (const field of ISSUE_VALUE_FIELDS) {
        const name = taiga[field];
        if (name === null || name === undefined) throw new PullError(`issue ${key} has no ${field} the project defines on Taiga; set one there and pull again, or ${SETTLE}`, key);
        issueFields[field] = name;
      }
      return { type: 'issue', key, fields: issueFields };
    }
    case 'task': {
      const story = taiga.story ?? null;
      if (story === null || located.get(story)?.type !== 'story') {
        throw new PullError(`task ${key} is in ${story === null ? 'no backlog story' : `story ${story}, which backlog.yaml does not hold,`} on Taiga; ${SETTLE}`, key);
      }
      return { type: 'task', key, parent: story, fields };
    }
    case 'story': {
      const { format } = item.spec;
      const parsed = parseStoryDescription(taiga.description, format);
      if (!parsed) {
        throw new PullError(
          `story ${key}: its description on Taiga does not follow the ${format === 'user-story' ? 'user story' : 'legacy'} template, so it cannot be ` +
            `split back into ${format === 'user-story' ? 'use_case, description, scenarios and spec' : 'description, acceptance_criteria and spec'}; ` +
            `rewrite the story in backlog.yaml from Taiga's description (in --json), then pull it with --keep-manifest so that apply writes it`,
          key,
          taiga.description,
        );
      }
      // The manifest's epic while the story is still linked to it on Taiga, else the one backlog epic it is linked to.
      const epics = (taiga.epics ?? []).filter((epic) => located.get(epic)?.type === 'epic');
      const parent = epics.includes(item.parent) ? item.parent : epics.length === 1 ? epics[0]! : undefined;
      if (parent === undefined) {
        throw new PullError(`story ${key} is linked on Taiga to ${epics.length === 0 ? 'no backlog epic' : `several backlog epics (${epics.join(', ')})`}; ${SETTLE}`, key);
      }
      const storyFields: StoryFields = {
        ...fields,
        description: parsed.description,
        spec: parsed.spec,
        ...(parsed.format === 'user-story' ? { useCase: parsed.useCase, scenarios: parsed.scenarios } : { acceptanceCriteria: parsed.acceptanceCriteria }),
      };
      return { type: 'story', key, parent, fields: storyFields };
    }
  }
}

/**
 * Pulls the backlog item `request.key`, or every item the plan blocks, from Taiga into the project's backlog.yaml
 * (unless `keepManifest`) and sets their baseline in state.json to Taiga's values. All items or none: on a PullError
 * or an invalid result no file is written.
 */
export async function pullItems(layout: ProjectLayout, backlog: Backlog, { plan, counterparts }: PlannedBacklog, request: PullRequest): Promise<PullReport> {
  const located = locate(backlog);
  let keys = plan.blocked.map((item) => item.key);
  if (request.key !== undefined) {
    const { key } = request;
    if (!located.has(key)) throw new PullKeyError(`no backlog item ${key} in backlog.yaml`);
    if (!counterparts.has(key)) throw new PullKeyError(`${key} is not on Taiga yet (no item carries src:${key.toLowerCase()}; apply creates or adopts it): nothing to pull`);
    keys = [key];
  }
  const pulled = keys.map((key): PulledItem => {
    const { type, item, taiga, manifest } = counterparts.get(key)!;
    const blocked = plan.blocked.find((candidate) => candidate.key === key);
    const fields = blocked ? (Object.keys(blocked.fields) as ManagedField[]) : differingFields(manifest, taiga);
    return { type, key, id: item.id, ref: item.ref, kind: blocked?.kind ?? null, fields };
  });
  if (keys.length === 0) return { project: plan.project, keepManifest: request.keepManifest, pulled };

  if (!request.keepManifest) {
    const items = keys.map((key) => ({ original: key, item: pulledItem(located.get(key)!, counterparts.get(key)!, located) }));
    const manifest = await readManifestFile(layout.dir, 'backlog');
    const saved = await saveItems(layout.dir, { baseDigest: manifest.digest, items });
    if (saved.status === 'invalid') throw new ManifestError(saved.issues);
    if (saved.status === 'conflict') throw new PullError('backlog.yaml changed while pulling; nothing was written, run pull again', keys[0]!);
  }
  const state = await readState(layout.state, plan.project);
  for (const key of keys) {
    const { type, item, taiga } = counterparts.get(key)!;
    state.items[key] = { type, id: item.id, ref: item.ref, version: item.version, baseline: taiga };
  }
  await writeState(layout.state, state);
  return { project: plan.project, keepManifest: request.keepManifest, pulled };
}

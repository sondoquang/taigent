// Manifest module: loads and validates `taiga/<slug>/backlog.yaml`. No network I/O.

import { isRecord } from '../guards.ts';
import { checkKey, checkTag } from './conventions.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import { readManifestYaml } from './yaml.ts';

export const BACKLOG_FILE = 'backlog.yaml';

/** A custom attribute value as written in the manifest (Taiga stores it as JSON). */
export type AttributeValue = string | number | boolean;

interface ItemSpec {
  key: string;
  subject: string;
  description: string;
  tags: string[];
  /** Attribute name → value; empty when the item declares none. */
  customAttributes: Record<string, AttributeValue>;
}

export type TaskSpec = ItemSpec;

export interface StorySpec extends ItemSpec {
  /** Rendered into the Taiga description under "Acceptance criteria". */
  acceptanceCriteria: string[];
  /** Link or path to the spec the story comes from; empty when absent. */
  spec: string;
  tasks: TaskSpec[];
}

export interface EpicSpec extends ItemSpec {
  stories: StorySpec[];
}

export interface Backlog {
  epics: EpicSpec[];
}

type Kind = 'epic' | 'story' | 'task';

const ITEM_FIELDS = ['key', 'subject', 'description', 'tags', 'custom_attributes'];
const KNOWN_FIELDS: Record<Kind, ReadonlySet<string>> = {
  epic: new Set([...ITEM_FIELDS, 'stories']),
  story: new Set([...ITEM_FIELDS, 'acceptance_criteria', 'spec', 'tasks']),
  task: new Set(ITEM_FIELDS),
};

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '');
}

/** Every item key declared in the backlog (epics, stories and tasks). */
export function backlogKeys(backlog: Backlog): Set<string> {
  const keys = new Set<string>();
  for (const epic of backlog.epics) {
    keys.add(epic.key);
    for (const story of epic.stories) {
      keys.add(story.key);
      for (const task of story.tasks) keys.add(task.key);
    }
  }
  return keys;
}

/** Reads and validates the backlog manifest at `path`; throws ManifestError listing every issue. */
export async function loadBacklog(path: string): Promise<Backlog> {
  const doc = await readManifestYaml(path);

  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });

  if (!isRecord(doc)) {
    issue('', 'type', 'backlog must be a mapping with an `epics` list');
    throw new ManifestError(issues);
  }
  const seenKeys = new Map<string, string>();

  /** Validates the fields every item has; returns undefined when `raw` is not a mapping. */
  function checkItem(raw: unknown, at: string, kind: Kind): (ItemSpec & { raw: Record<string, unknown> }) | undefined {
    if (!isRecord(raw)) {
      issue(at, 'type', `${kind} must be a mapping`);
      return undefined;
    }
    for (const field of Object.keys(raw)) {
      if (!KNOWN_FIELDS[kind].has(field)) issue(`${at}.${field}`, 'known-field', `unknown ${kind} field \`${field}\``);
    }
    const { key, subject, description = '', tags = [], custom_attributes: customAttributes = {} } = raw;
    checkKey(key, `${at}.key`, issue, seenKeys);
    if (typeof subject !== 'string' || subject.trim() === '') issue(`${at}.subject`, 'required', 'subject is required');
    if (typeof description !== 'string') issue(`${at}.description`, 'type', 'must be a string');
    if (!Array.isArray(tags)) issue(`${at}.tags`, 'type', 'must be a list of tags');
    else tags.forEach((tag: unknown, i) => checkTag(tag, `${at}.tags[${i}]`, issue));
    if (!isRecord(customAttributes)) issue(`${at}.custom_attributes`, 'type', 'must be a mapping of attribute name to value');
    else {
      for (const [name, value] of Object.entries(customAttributes)) {
        if (name.trim() === '') issue(`${at}.custom_attributes`, 'required', 'attribute names must not be empty');
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          issue(`${at}.custom_attributes.${name}`, 'type', 'must be a string, number or boolean');
        }
      }
    }
    return { key, subject, description, tags, customAttributes, raw } as ItemSpec & { raw: Record<string, unknown> };
  }

  /** Children list of an item (`stories`, `tasks`): absent means empty. */
  function children(value: unknown, at: string): unknown[] {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    issue(at, 'type', 'must be a list');
    return [];
  }

  const rawEpics = doc.epics ?? [];
  if (!Array.isArray(rawEpics)) {
    issue('epics', 'type', 'must be a list');
    throw new ManifestError(issues);
  }

  const epics: EpicSpec[] = [];
  rawEpics.forEach((rawEpic: unknown, e) => {
    const epicAt = `epics[${e}]`;
    const epic = checkItem(rawEpic, epicAt, 'epic');
    if (!epic) return;
    const stories: StorySpec[] = [];
    children(epic.raw.stories, `${epicAt}.stories`).forEach((rawStory, s) => {
      const storyAt = `${epicAt}.stories[${s}]`;
      const story = checkItem(rawStory, storyAt, 'story');
      if (!story) return;
      const { acceptance_criteria: acceptanceCriteria = [], spec = '' } = story.raw;
      if (!isStringList(acceptanceCriteria)) issue(`${storyAt}.acceptance_criteria`, 'type', 'must be a list of non-empty strings');
      if (typeof spec !== 'string') issue(`${storyAt}.spec`, 'type', 'must be a string');
      const tasks: TaskSpec[] = [];
      children(story.raw.tasks, `${storyAt}.tasks`).forEach((rawTask, t) => {
        const task = checkItem(rawTask, `${storyAt}.tasks[${t}]`, 'task');
        if (task) tasks.push({ key: task.key, subject: task.subject, description: task.description, tags: task.tags, customAttributes: task.customAttributes });
      });
      stories.push({
        key: story.key,
        subject: story.subject,
        description: story.description,
        tags: story.tags,
        customAttributes: story.customAttributes,
        acceptanceCriteria: acceptanceCriteria as string[],
        spec: spec as string,
        tasks,
      });
    });
    epics.push({ key: epic.key, subject: epic.subject, description: epic.description, tags: epic.tags, customAttributes: epic.customAttributes, stories });
  });

  if (issues.length > 0) throw new ManifestError(issues);
  return { epics };
}

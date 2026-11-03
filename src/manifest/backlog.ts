// Manifest module: loads and validates `taiga/<slug>/backlog.yaml`. No network I/O.

import { isRecord } from '../guards.ts';
import { ISSUE_VALUE_FIELDS, type IssueValueField } from '../items.ts';
import { checkKey, checkTag } from './conventions.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import { readManifestYaml } from './yaml.ts';

export const BACKLOG_FILE = 'backlog.yaml';

/** A custom attribute value as written in the manifest (Taiga stores it as JSON). */
export type AttributeValue = string | number | boolean;

interface ItemSpec {
  key: string;
  /** Taiga ref of the hand-made item this backlog item adopts (`taigent adopt`); stays after apply as an assertion. */
  ref?: number;
  subject: string;
  description: string;
  tags: string[];
  /** Attribute name → value; empty when the item declares none. */
  customAttributes: Record<string, AttributeValue>;
}

export type TaskSpec = ItemSpec;

/** The Mike Cohn use case of a story: "As a … I want to … so that …". */
export interface UseCase {
  asA: string;
  iWantTo: string;
  soThat: string;
}

/** One Gherkin acceptance scenario: one or more Given, exactly one When and one Then. */
export interface Scenario {
  scenario: string;
  given: string[];
  when: string;
  then: string;
}

interface StoryCommon extends ItemSpec {
  /** Link or path to the spec the story comes from; empty when absent. */
  spec: string;
  tasks: TaskSpec[];
}

/** User story format: a use case and Gherkin scenarios as acceptance criteria. */
export interface UserStoryFormat {
  format: 'user-story';
  useCase: UseCase;
  scenarios: Scenario[];
}

/** Legacy format, kept only for stories already on Taiga: acceptance criteria as a plain checklist. */
export interface LegacyFormat {
  format: 'legacy';
  acceptanceCriteria: string[];
}

/** A story is in exactly one format: a story mixing both is a `story-format` issue, never a StorySpec. */
export type StorySpec = StoryCommon & (UserStoryFormat | LegacyFormat);

export interface EpicSpec extends ItemSpec {
  stories: StorySpec[];
}

/**
 * An issue (bug, question, enhancement): a top-level backlog item, outside the epic tree. `type`, `severity` and
 * `priority` are names of the project's own values on Taiga; plan/apply resolve them to ids.
 */
export interface IssueSpec extends ItemSpec, Record<IssueValueField, string> {}

export interface Backlog {
  epics: EpicSpec[];
  issues: IssueSpec[];
}

type Kind = 'epic' | 'story' | 'task' | 'issue';

const ITEM_FIELDS = ['key', 'ref', 'subject', 'description', 'tags', 'custom_attributes'];
const KNOWN_FIELDS: Record<Kind, readonly string[]> = {
  epic: [...ITEM_FIELDS, 'stories'],
  story: [...ITEM_FIELDS, 'acceptance_criteria', 'use_case', 'scenarios', 'spec', 'tasks'],
  task: ITEM_FIELDS,
  issue: [...ITEM_FIELDS, ...ISSUE_VALUE_FIELDS],
};
const USE_CASE_FIELDS = ['as_a', 'i_want_to', 'so_that'] as const;
const SCENARIO_FIELDS = ['scenario', 'given', 'when', 'then'] as const;
/** Stands in for an invalid or missing use case; the issue it comes with keeps the backlog from loading. */
const NO_USE_CASE: UseCase = { asA: '', iWantTo: '', soThat: '' };

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '');
}

/** Manifest path of the `e`-th epic, as issues name it. */
export function epicPath(e: number): string {
  return `epics[${e}]`;
}

/** Manifest path of the `s`-th story of the `e`-th epic, as issues name it. */
export function storyPath(e: number, s: number): string {
  return `${epicPath(e)}.stories[${s}]`;
}

/** Manifest path of the `i`-th issue, as issues name it. */
export function issuePath(i: number): string {
  return `issues[${i}]`;
}

/** A story `plan` would create in the legacy format: `path` locates it in backlog.yaml. */
export interface LegacyStoryCreate {
  key: string;
  path: string;
}

/** The `story-format` issues of backlog `file` for stories that would be created in the legacy format. */
export function legacyStoryCreatesError(file: string, stories: readonly LegacyStoryCreate[]): ManifestError {
  return new ManifestError(
    stories.map(({ key, path }) => ({
      file,
      path,
      rule: 'story-format',
      message: `new story ${key} must use use_case and scenarios (conventions §6); the legacy format is only kept for stories already on Taiga`,
    })),
  );
}

/** An issue value (`type`, `severity`, `priority`) whose name the project does not define on Taiga. */
export interface UnknownIssueValue {
  key: string;
  /** `issues[i].<field>`. */
  path: string;
  field: IssueValueField;
  value: string;
  /** The names the project defines for `field`, in Taiga's order. */
  names: readonly string[];
}

/** The `issue-value` issues of backlog `file`: names are matched exactly against the project's values. */
export function unknownIssueValuesError(file: string, values: readonly UnknownIssueValue[]): ManifestError {
  return new ManifestError(
    values.map(({ key, path, field, value, names }) => ({
      file,
      path,
      rule: 'issue-value',
      message: `issue ${key}: ${field} "${value}" is not defined on the project; ${field} values on Taiga: ${names.map((name) => `"${name}"`).join(', ') || 'none'}`,
    })),
  );
}

/** Every key of the epic tree (epics, stories and tasks): the items attachments may name (review: `reviewKeys`). */
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
  return checkBacklog(await readManifestYaml(path), path);
}

/**
 * Validates `doc`, the parsed content of the backlog manifest `path` (issues name that file); throws ManifestError
 * listing every issue. The manifest edit API checks an edited backlog with it before writing.
 */
export function checkBacklog(doc: unknown, path: string): Backlog {
  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });

  if (!isRecord(doc)) {
    issue('', 'type', 'backlog must be a mapping with an `epics` list and optional `issues` list');
    throw new ManifestError(issues);
  }
  const seenKeys = new Map<string, string>();
  const seenRefs = new Map<number, string>();

  /** Validates the fields every item has; returns undefined when `raw` is not a mapping. */
  function checkItem(raw: unknown, at: string, kind: Kind): { spec: ItemSpec; raw: Record<string, unknown> } | undefined {
    if (!isRecord(raw)) {
      issue(at, 'type', `${kind} must be a mapping`);
      return undefined;
    }
    checkKnownFields(raw, at, KNOWN_FIELDS[kind], kind);
    const { key, ref, subject, description = '', tags = [], custom_attributes: customAttributes = {} } = raw;
    checkKey(key, `${at}.key`, issue, seenKeys);
    if (ref !== undefined) {
      if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 1) issue(`${at}.ref`, 'type', "must be a positive integer: the item's #ref on Taiga");
      else if (seenRefs.has(ref)) issue(`${at}.ref`, 'ref-unique', `ref ${ref} is already adopted by ${seenRefs.get(ref)}`);
      else seenRefs.set(ref, at);
    }
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
    const spec = { key, ...(ref !== undefined && { ref }), subject, description, tags, customAttributes } as ItemSpec;
    return { spec, raw };
  }

  /** Children list of an item (`stories`, `tasks`): absent means empty. */
  function children(value: unknown, at: string): unknown[] {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value;
    issue(at, 'type', 'must be a list');
    return [];
  }

  /** Flags fields of a nested mapping outside `allowed` as `known-field`. */
  function checkKnownFields(raw: Record<string, unknown>, at: string, allowed: readonly string[], what: string): void {
    for (const field of Object.keys(raw)) {
      if (!allowed.includes(field)) issue(`${at}.${field}`, 'known-field', `unknown ${what} field \`${field}\``);
    }
  }

  /** A required non-empty string field: missing or empty is `required`, any other non-string is `type`. */
  function checkText(value: unknown, at: string): string {
    if (value === undefined || value === null || value === '') issue(at, 'required', 'must be a non-empty string');
    else if (typeof value !== 'string') issue(at, 'type', 'must be a string');
    return typeof value === 'string' ? value : '';
  }

  function checkUseCase(raw: unknown, at: string): UseCase {
    if (!isRecord(raw)) {
      issue(at, 'type', 'must be a mapping with `as_a`, `i_want_to` and `so_that`');
      return NO_USE_CASE;
    }
    checkKnownFields(raw, at, USE_CASE_FIELDS, 'use case');
    return { asA: checkText(raw.as_a, `${at}.as_a`), iWantTo: checkText(raw.i_want_to, `${at}.i_want_to`), soThat: checkText(raw.so_that, `${at}.so_that`) };
  }

  function checkScenarios(raw: unknown, at: string): Scenario[] {
    if (!Array.isArray(raw)) {
      issue(at, 'type', 'must be a list of scenarios');
      return [];
    }
    if (raw.length === 0) issue(at, 'required', 'needs at least one scenario');
    const scenarios: Scenario[] = [];
    raw.forEach((rawScenario: unknown, i) => {
      const scenarioAt = `${at}[${i}]`;
      if (!isRecord(rawScenario)) {
        issue(scenarioAt, 'type', 'scenario must be a mapping with `scenario`, `given`, `when` and `then`');
        return;
      }
      checkKnownFields(rawScenario, scenarioAt, SCENARIO_FIELDS, 'scenario');
      const scenario = checkText(rawScenario.scenario, `${scenarioAt}.scenario`);
      const { given } = rawScenario;
      if (given === undefined || (Array.isArray(given) && given.length === 0)) issue(`${scenarioAt}.given`, 'required', 'needs at least one Given');
      else if (!isStringList(given)) issue(`${scenarioAt}.given`, 'type', 'must be a list of non-empty strings');
      const when = checkText(rawScenario.when, `${scenarioAt}.when`);
      const then = checkText(rawScenario.then, `${scenarioAt}.then`);
      scenarios.push({ scenario, given: isStringList(given) ? given : [], when, then });
    });
    return scenarios;
  }

  const rawEpics = doc.epics ?? [];
  if (!Array.isArray(rawEpics)) {
    issue('epics', 'type', 'must be a list');
    throw new ManifestError(issues);
  }

  const epics: EpicSpec[] = [];
  rawEpics.forEach((rawEpic: unknown, e) => {
    const epicAt = epicPath(e);
    const epic = checkItem(rawEpic, epicAt, 'epic');
    if (!epic) return;
    const stories: StorySpec[] = [];
    children(epic.raw.stories, `${epicAt}.stories`).forEach((rawStory, s) => {
      const storyAt = storyPath(e, s);
      const story = checkItem(rawStory, storyAt, 'story');
      if (!story) return;
      const { acceptance_criteria: acceptanceCriteria = [], spec = '' } = story.raw;
      if (!isStringList(acceptanceCriteria)) issue(`${storyAt}.acceptance_criteria`, 'type', 'must be a list of non-empty strings');
      const hasUseCase = story.raw.use_case !== undefined;
      const hasScenarios = story.raw.scenarios !== undefined;
      const useCase = hasUseCase ? checkUseCase(story.raw.use_case, `${storyAt}.use_case`) : NO_USE_CASE;
      const scenarios = hasScenarios ? checkScenarios(story.raw.scenarios, `${storyAt}.scenarios`) : [];
      if (hasUseCase && !hasScenarios) issue(`${storyAt}.scenarios`, 'story-format', '`use_case` needs `scenarios`');
      if (hasScenarios && !hasUseCase) issue(`${storyAt}.use_case`, 'story-format', '`scenarios` needs `use_case`');
      if ((hasUseCase || hasScenarios) && story.raw.acceptance_criteria !== undefined) {
        issue(`${storyAt}.acceptance_criteria`, 'story-format', 'a story uses either `acceptance_criteria` or `use_case` + `scenarios`, not both');
      }
      if (typeof spec !== 'string') issue(`${storyAt}.spec`, 'type', 'must be a string');
      const tasks: TaskSpec[] = [];
      children(story.raw.tasks, `${storyAt}.tasks`).forEach((rawTask, t) => {
        const task = checkItem(rawTask, `${storyAt}.tasks[${t}]`, 'task');
        if (task) tasks.push(task.spec);
      });
      const format: UserStoryFormat | LegacyFormat =
        hasUseCase || hasScenarios
          ? { format: 'user-story', useCase, scenarios }
          : { format: 'legacy', acceptanceCriteria: acceptanceCriteria as string[] };
      stories.push({ ...story.spec, ...format, spec: spec as string, tasks });
    });
    epics.push({ ...epic.spec, stories });
  });

  const issueSpecs: IssueSpec[] = [];
  children(doc.issues, 'issues').forEach((rawIssue, i) => {
    const issueAt = issuePath(i);
    const item = checkItem(rawIssue, issueAt, 'issue');
    if (!item) return;
    const [type, severity, priority] = ISSUE_VALUE_FIELDS.map((field) => checkText(item.raw[field], `${issueAt}.${field}`)) as [string, string, string];
    issueSpecs.push({ ...item.spec, type, severity, priority });
  });

  if (issues.length > 0) throw new ManifestError(issues);
  return { epics, issues: issueSpecs };
}

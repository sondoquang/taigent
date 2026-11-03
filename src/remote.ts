// Remote reader of `plan`/`apply`: reads back from Taiga what the pure planner (`buildPlan`) compares the backlog
// with: the project's items, the epic links, the issue values and the custom attribute values that matter for this
// backlog.

import { ISSUE_VALUE_FIELDS, ITEM_TYPES, type IssueValueField, type ItemType } from './items.ts';
import type { Backlog } from './manifest/backlog.ts';
import { srcTag, type RemoteState } from './planner.ts';
import type { TaigaAttributeValues, TaigaClient, TaigaIssueValue } from './taiga/client.ts';

export async function readBacklogRemote(backlog: Backlog, client: TaigaClient, slug: string): Promise<RemoteState> {
  const project = await client.getProjectBySlug(slug);
  const [epics, stories, tasks, issues] = await Promise.all([
    client.listItems('epic', project.id),
    client.listItems('story', project.id),
    client.listItems('task', project.id),
    client.listItems('issue', project.id),
  ]);

  // The project's issue types, severities and priorities, to resolve the names of the manifest's issues.
  const issueValues = {} as Record<IssueValueField, TaigaIssueValue[]>;
  for (const field of ISSUE_VALUE_FIELDS) {
    issueValues[field] = backlog.issues.length > 0 ? await client.listIssueValues(field, project.id) : [];
  }

  // Links of every taigent-managed epic and of every epic the backlog adopts (`ref`): missing ones are planned, those
  // to an epic the story left are reported, and hand-made stories under a backlog epic are listed apart.
  const adoptedEpics = new Set(backlog.epics.flatMap((epic) => epic.ref ?? []));
  const epicStories = new Map<number, number[]>();
  for (const epic of epics) {
    if (epic.tags.some((tag) => tag.startsWith('src:')) || adoptedEpics.has(epic.ref)) epicStories.set(epic.id, await client.listEpicUserStories(epic.id));
  }

  // Current custom attribute values, only for existing items (by `src:` tag, or adopted by `ref`) that declare some
  // in the manifest.
  const declaringTags = new Set<string>();
  const declaringRefs = new Set<number>();
  for (const item of [...backlog.epics.flatMap((epic) => [epic, ...epic.stories, ...epic.stories.flatMap((story) => story.tasks)]), ...backlog.issues]) {
    if (Object.keys(item.customAttributes).length === 0) continue;
    declaringTags.add(srcTag(item.key));
    if (item.ref !== undefined) declaringRefs.add(item.ref);
  }
  const items = { epic: epics, story: stories, task: tasks, issue: issues };
  const attributeValues = {} as Record<ItemType, Map<number, TaigaAttributeValues>>;
  for (const type of ITEM_TYPES) {
    attributeValues[type] = new Map();
    for (const item of items[type]) {
      if (item.tags.some((tag) => declaringTags.has(tag)) || declaringRefs.has(item.ref)) attributeValues[type].set(item.id, await client.getAttributeValues(type, item.id));
    }
  }

  return {
    project: { id: project.id, slug: project.slug },
    epics,
    stories,
    tasks,
    issues,
    issueValues,
    epicStories,
    customAttributes: project.customAttributes,
    attributeValues,
  };
}

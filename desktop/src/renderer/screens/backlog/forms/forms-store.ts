// What the Backlog forms have open: the item form (epic, story, task, issue) with backlog.yaml as it read the file,
// and the removal warning. The item actions and the "+ Epic" / "+ Issue" buttons open them here; `BacklogForms`
// renders them. Saves and removals go through the manifest edit API (`src/edit.ts`, via `window.taigent`).

import { create } from 'zustand';
import type { BacklogSnapshot, ItemType, ManifestFile, PreviewItem, ProjectView } from '../../../../shared/api.ts';
import { applyView, toast } from '@/actions.ts';
import { showConflict } from '@/components/conflict-dialog.tsx';
import { api, useApp } from '@/store.ts';

export interface OpenForm {
  /** Grows with every opening, so a new form starts from fresh state. */
  id: number;
  type: ItemType;
  slug: string;
  /** The project as the form opened: its parents and the keys already taken. */
  view: ProjectView;
  /** The item being edited; absent for a new item. */
  original?: PreviewItem;
  /** The epic (new story) or story (new task) the item is added under. */
  parent?: string;
  /** backlog.yaml as the form opened it: its digest guards the save, its text is the "before" of a conflict. */
  base: BacklogSnapshot;
  /** backlog.yaml changed on disk since `base` (an agent edited it). */
  stale: boolean;
}

export interface PendingRemoval {
  slug: string;
  item: PreviewItem;
  /** backlog.yaml when the warning opened: its digest guards the removal. */
  base: ManifestFile;
  /** The item and every item under it, which go with it. */
  removed: PreviewItem[];
}

export const useForms = create<{ form?: OpenForm; removal?: PendingRemoval }>(() => ({}));

let opened = 0;

/** Every item of the epic tree, in tree order. */
export function allItems(view: ProjectView): PreviewItem[] {
  return view.preview.epics.flatMap((epic) => [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])]);
}

/** The item and every item under it (an epic's stories and tasks, a story's tasks). */
function withChildren(view: ProjectView, item: PreviewItem): PreviewItem[] {
  for (const epic of view.preview.epics) {
    if (epic.key === item.key && item.type === 'epic') return [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])];
    for (const story of epic.stories) {
      if (story.key === item.key && item.type === 'story') return [story, ...story.tasks];
    }
  }
  return [item];
}

/** Opens the form of a new item of `type` (under `parent`), or of `original` to edit it. */
export async function openForm(type: ItemType, original?: PreviewItem, parent?: string): Promise<void> {
  const view = useApp.getState().view;
  if (!view) {
    toast('Chọn dự án trước.', 'error');
    return;
  }
  // A story's form edits its manifest fields (use case, scenarios…), not the description the preview composes; an
  // issue's form edits its type, severity and priority as backlog.yaml names them.
  const edited = (type === 'story' || type === 'issue') && original ? { type, key: original.key } : undefined;
  const snapshot = await api.readBacklog(view.slug, edited);
  if (!snapshot.ok) {
    toast(snapshot.message, 'error');
    return;
  }
  if (edited && !snapshot.value.item) {
    toast(`Không tìm thấy ${type} ${edited.key} trong backlog.yaml.`, 'error');
    return;
  }
  opened += 1;
  useForms.setState({
    form: { id: opened, type, slug: view.slug, view, base: snapshot.value, stale: false, ...(original && { original }), ...(parent !== undefined && { parent }) },
  });
}

export function closeForm(): void {
  useForms.setState({ form: undefined });
}

/** Updates form `id` (the stale notice, the base after a conflict); ignored once that form closed. */
export function updateForm(id: number, change: Partial<Pick<OpenForm, 'base' | 'stale'>>): void {
  const form = useForms.getState().form;
  if (form?.id === id) useForms.setState({ form: { ...form, ...change } });
}

/** Opens the removal warning of `item`, listing the items under it and those already on Taiga. */
export async function confirmRemove(item: PreviewItem): Promise<void> {
  const view = useApp.getState().view;
  if (!view) return;
  const snapshot = await api.readBacklog(view.slug);
  if (!snapshot.ok) {
    toast(snapshot.message, 'error');
    return;
  }
  useForms.setState({ removal: { slug: view.slug, item, base: snapshot.value.file, removed: withChildren(view, item) } });
}

export function closeRemoval(): void {
  useForms.setState({ removal: undefined });
}

/** Removes `item` from backlog.yaml `base`; a conflict opens the conflict dialog, whose "Áp lại" removes it from the current file. */
export async function removeItem(slug: string, item: PreviewItem, base: ManifestFile): Promise<void> {
  const result = await api.removeItem(slug, { baseDigest: base.digest, type: item.type, key: item.key });
  if (!result.ok) {
    toast(result.message, 'error');
    return;
  }
  const outcome = result.value;
  if (outcome.status === 'conflict') {
    showConflict(base, outcome.current, () => void removeItem(slug, item, outcome.current));
    return;
  }
  if (outcome.status === 'invalid') {
    toast(outcome.issues.map((issue) => issue.message).join('; '), 'error');
    return;
  }
  applyView(outcome.view);
  toast(
    outcome.orphaned.length > 0
      ? `Đã xoá ${outcome.removed.join(', ')}. Trên Taiga còn ${outcome.orphaned.join(', ')} (mồ côi).`
      : `Đã xoá ${outcome.removed.join(', ')}.`,
  );
}

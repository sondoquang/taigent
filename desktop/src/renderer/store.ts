// The renderer's shared state: the opened repository and project, the Backlog selection, the Taiga login, the shown
// section and the result dialog. Everything it knows comes through `window.taigent` (preload); it never reaches the
// file system or the network itself. Screen-local state (forms, Git, Wiki…) lives in the screens, which stay mounted
// while hidden, so switching sections keeps every draft.

import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { AppState, Failure, HeadlessAgent, LoginStatus, PreviewEpic, PreviewItem, PreviewStory, ProjectView, RepoInfo, TaigentApi } from '../shared/api.ts';

declare global {
  interface Window {
    taigent: TaigentApi;
  }
}

export const api: TaigentApi = window.taigent;

export const SECTIONS = ['backlog', 'wiki', 'taiga', 'changes', 'git', 'setup', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

export type Filter = 'all' | 'unreviewed' | 'changes' | 'stale';

/** A row of the Backlog tree: an epic-tree item with its parents, or an issue (no parent). */
export interface TreeNode {
  item: PreviewItem;
  depth: number;
  epic?: PreviewEpic;
  story?: PreviewStory;
}

export interface ResultDialogContent {
  title: string;
  content?: ReactNode;
  failure?: Failure;
}

export interface AppStore {
  section: Section;
  repo?: RepoInfo;
  view?: ProjectView;
  /** Key of the item selected in the Backlog tree. */
  selected?: string;
  filter: Filter;
  login?: LoginStatus;
  /** A `taigent plan` or `apply` runs (Thay đổi). */
  busy: boolean;
  versions?: AppState['versions'];
  /** The modal result dialog (a read failure, an invalid manifest…); undefined when closed. */
  result?: ResultDialogContent;
  /** The login dialog, or the logout confirmation when logged in; undefined when closed. */
  account?: 'login' | 'logout';
  /** The agent of the headless skill buttons (Backlog agent bar, Settings); read from settings.json at start. */
  headlessAgent: HeadlessAgent;
}

export const useApp = create<AppStore>(() => ({
  section: 'backlog',
  filter: 'all',
  busy: false,
  headlessAgent: 'omp',
}));

export function matches(item: PreviewItem, filter: Filter): boolean {
  if (filter === 'unreviewed') return !item.review.verdict;
  if (filter === 'changes') return item.review.verdict === 'changes' && !item.review.stale;
  if (filter === 'stale') return item.review.stale;
  return true;
}

/** The tree in display order, epics then issues; with a filter, an item shows when it or one of its children matches. */
export function visibleNodes(view: ProjectView, filter: Filter): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const epic of view.preview.epics) {
    const storyNodes: TreeNode[] = [];
    for (const story of epic.stories) {
      const tasks = story.tasks.filter((task) => matches(task, filter)).map((task) => ({ item: task, depth: 2, epic, story }));
      if (matches(story, filter) || tasks.length > 0) storyNodes.push({ item: story, depth: 1, epic, story }, ...tasks);
    }
    if (matches(epic, filter) || storyNodes.length > 0) nodes.push({ item: epic, depth: 0, epic }, ...storyNodes);
  }
  for (const issue of view.preview.issues) if (matches(issue, filter)) nodes.push({ item: issue, depth: 0 });
  return nodes;
}

export function findNode(view: ProjectView, key: string | undefined): TreeNode | undefined {
  return key === undefined ? undefined : visibleNodes(view, 'all').find((node) => node.item.key === key);
}

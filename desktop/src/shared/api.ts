// The contract between the main process and the renderer: what `window.taigent` (preload) exposes. Review
// shapes and the manifest edit shapes come from taigent's core (`src/review.ts`, `src/edit.ts`, compiled to `dist/`), as types only.

import type { BacklogItem, EditResult, ManifestFile, RemoveItemRequest, SaveItemRequest } from '../../../src/edit.ts';
import type { ItemType } from '../../../src/items.ts';
import type { CustomAttributeSpec } from '../../../src/manifest/project.ts';
import type { Preview, PreviewEpic, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict } from '../../../src/review.ts';

export type { Preview, PreviewEpic, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict };
export type { BacklogItem, CustomAttributeSpec, EditResult, ItemType, ManifestFile, RemoveItemRequest, SaveItemRequest };

/** A failure the UI shows as is: `message` is already in Vietnamese, `detail` is the CLI's own text when there is one. */
export interface Failure {
  ok: false;
  message: string;
  detail?: string;
  issues?: ManifestIssue[];
}
export type Result<T> = { ok: true; value: T } | Failure;

export interface ManifestIssue {
  file: string;
  path: string;
  rule: string;
  message: string;
}

export interface ProjectEntry {
  slug: string;
  name?: string;
}

export interface RepoInfo {
  /** The opened repository folder (working directory of every CLI run). */
  root: string;
  /** The manifests root: TAIGENT_MANIFESTS_DIR (environment, then `<root>/.env`), default `<root>/taiga`. */
  manifestsDir: string;
  projects: ProjectEntry[];
}

export interface Validation {
  valid: boolean;
  issues: ManifestIssue[];
  /** Set when `taigent validate` could not run or failed for another reason. */
  error?: string;
}

/** What the renderer shows for one project; pushed again whenever a file under `taiga/<slug>/` changes. */
export interface ProjectView {
  slug: string;
  preview: Preview;
  validation: Validation;
  /** The name written as `by` on verdicts and comments. */
  reviewer: string;
}

export interface AppState {
  repo?: RepoInfo;
  reviewer: string;
  versions: { app: string; electron: string; node: string; taigent: string };
}

export interface LoginStatus {
  loggedIn: boolean;
  apiUrl?: string;
  username?: string;
  /** `login` (taigent login / this app) or `environment` (TAIGA_* variables). */
  source?: string;
  message?: string;
}

export interface LoginInput {
  apiUrl: string;
  username: string;
  password: string;
}

export interface PlanOperation {
  action: 'create' | 'update' | 'link' | 'skip';
  type: string;
  key: string;
  id?: number;
  ref?: number;
  parent?: string;
  epic?: string;
  fields?: { subject?: string };
  changes?: Record<string, unknown>;
}

export interface Plan {
  project: { id: number; slug: string };
  changes: boolean;
  summary: { create: number; update: number; link: number; skip: number };
  operations: PlanOperation[];
  orphans: { type: string; key: string; id: number; ref: number; subject: string }[];
  staleLinks: { key: string; ref: number; epic: string }[];
}

export interface ApplyReport {
  project: { id: number; slug: string };
  operations: { action: string; type: string; key: string; id: number; ref: number; epic?: string; result: string }[];
  summary: { created: number; updated: number; linked: number; unchanged: number };
}

export type ApplyOutcome =
  | { status: 'blocked'; reasons: string[] }
  | { status: 'no-changes'; plan: Plan }
  | { status: 'cancelled' }
  | { status: 'applied'; report: ApplyReport };

export type VerdictChoice = Verdict | 'clear';

/** backlog.yaml as a form opens it (its digest guards the save), with what the forms offer from project.yaml. */
export interface BacklogSnapshot {
  file: ManifestFile;
  /** Custom attributes project.yaml declares, per item type; empty without a valid project.yaml. */
  attributes: Record<ItemType, CustomAttributeSpec[]>;
  /** The item `readBacklog` was asked for, with every field its form edits (`readItem` of the edit API). */
  item?: BacklogItem;
}

/** An item of backlog.yaml a form edits. */
export interface ItemRef {
  type: BacklogItem['type'];
  key: string;
}

/** A save through the manifest edit API (`src/edit.ts`); once saved, `view` is the project read again. */
export type SaveOutcome = EditResult<{ path: string; view: Result<ProjectView> }>;
export type RemoveOutcome = EditResult<{ removed: string[]; orphaned: string[]; view: Result<ProjectView> }>;

export interface TaigentApi {
  getState(): Promise<AppState>;
  /** Shows the folder dialog; undefined when cancelled. */
  openRepo(): Promise<Result<RepoInfo> | undefined>;
  refreshRepo(): Promise<Result<RepoInfo>>;
  /** Builds the preview and starts watching the project folder (only one project is watched at a time). */
  openProject(slug: string): Promise<Result<ProjectView>>;
  setVerdict(slug: string, key: string, verdict: VerdictChoice): Promise<Result<ProjectView>>;
  addComment(slug: string, key: string, text: string): Promise<Result<ProjectView>>;
  whoami(): Promise<LoginStatus>;
  login(input: LoginInput): Promise<Result<LoginStatus>>;
  logout(): Promise<Result<LoginStatus>>;
  plan(slug: string): Promise<Result<Plan>>;
  apply(slug: string): Promise<Result<ApplyOutcome>>;
  openExternal(url: string): Promise<void>;
  /** Subscribes to live refreshes of the open project; returns the unsubscribe function. */
  onProjectChanged(listener: (view: Result<ProjectView>) => void): () => void;
  /** Reads backlog.yaml for a form, with the fields of item `item` when given (absent when it is not there). */
  readBacklog(slug: string, item?: ItemRef): Promise<Result<BacklogSnapshot>>;
  /** Adds or edits an item; refused (`conflict`) when backlog.yaml is no longer the file `baseDigest` names. */
  saveItem(slug: string, request: SaveItemRequest): Promise<Result<SaveOutcome>>;
  /** Removes an item with its children (a story's tasks); items on Taiga stay there as orphans. */
  removeItem(slug: string, request: RemoveItemRequest): Promise<Result<RemoveOutcome>>;
}

export const CHANNELS = {
  getState: 'taigent:get-state',
  openRepo: 'taigent:open-repo',
  refreshRepo: 'taigent:refresh-repo',
  openProject: 'taigent:open-project',
  setVerdict: 'taigent:set-verdict',
  addComment: 'taigent:add-comment',
  whoami: 'taigent:whoami',
  login: 'taigent:login',
  logout: 'taigent:logout',
  plan: 'taigent:plan',
  apply: 'taigent:apply',
  openExternal: 'taigent:open-external',
  projectChanged: 'taigent:project-changed',
  readBacklog: 'taigent:read-backlog',
  saveItem: 'taigent:save-item',
  removeItem: 'taigent:remove-item',
} as const;

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

/** A changed file in the Git section's scope, repo-relative with `/`. */
export interface GitChange {
  path: string;
  state: 'modified' | 'added' | 'deleted' | 'untracked' | 'conflicted';
}

/** The Git section's view of the opened repository. */
export interface GitStatus {
  /** The current branch; undefined on a detached HEAD. */
  branch?: string;
  /** `<remote>/<branch>` the section pulls from and pushes to; undefined when the branch tracks none. */
  upstream?: string;
  /** Commits not pushed / not pulled yet, against the last fetch of the upstream. */
  ahead: number;
  behind: number;
  /** Repo-relative paths the section may add: the manifests folder and the files its docs.yaml files reference. */
  scope: string[];
  /** Changed files within the scope. */
  changes: GitChange[];
  /** Changed files outside the scope: never added, committed or pushed by the app. */
  outside: number;
}

/** Why a git action stopped before doing anything git could not undo; `message` is Vietnamese. */
export interface GitStop {
  reason: 'no-git' | 'not-repo' | 'detached' | 'no-remote' | 'no-upstream' | 'conflict' | 'diverged' | 'behind' | 'outside-commits' | 'failed';
  message: string;
  /** git's own output, when a git command failed. */
  detail?: string;
  /** Commands to run in a terminal at the repository. */
  commands: string[];
  /** True when the app opened the repository for the user to continue in a terminal. */
  terminal: boolean;
}

export type GitOutcome = { kind: 'ok'; status: GitStatus; summary?: string } | { kind: 'stopped'; stop: GitStop; status?: GitStatus };

/** backlog.yaml as a form opens it (its digest guards the save), with what the forms offer from project.yaml. */
export interface BacklogSnapshot {
  file: ManifestFile;
  /** Custom attributes project.yaml declares, per item type; empty without a valid project.yaml. */
  attributes: Record<ItemType, CustomAttributeSpec[]>;
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
  /** Reads backlog.yaml for a form. */
  readBacklog(slug: string): Promise<Result<BacklogSnapshot>>;
  /** Adds or edits an item; refused (`conflict`) when backlog.yaml is no longer the file `baseDigest` names. */
  saveItem(slug: string, request: SaveItemRequest): Promise<Result<SaveOutcome>>;
  /** Removes an item with its children (a story's tasks); items on Taiga stay there as orphans. */
  removeItem(slug: string, request: RemoveItemRequest): Promise<Result<RemoveOutcome>>;
  /** Status of the opened repository within the Git section's scope. */
  gitStatus(): Promise<Result<GitOutcome>>;
  /** `git pull --ff-only`; stops on a diverged history without touching the working tree. */
  gitPull(): Promise<Result<GitOutcome>>;
  /** Adds and commits exactly the changed files in scope with `message`, then pushes to the upstream. */
  gitCommitPush(message: string): Promise<Result<GitOutcome>>;
  /** Pushes local commits that only touch the scope. */
  gitPush(): Promise<Result<GitOutcome>>;
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
  gitStatus: 'taigent:git-status',
  gitPull: 'taigent:git-pull',
  gitCommitPush: 'taigent:git-commit-push',
  gitPush: 'taigent:git-push',
} as const;

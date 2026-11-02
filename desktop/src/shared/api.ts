// The contract between the main process and the renderer: what `window.taigent` (preload) exposes. Review
// shapes and the manifest edit shapes come from taigent's core (`src/review.ts`, `src/edit.ts`, compiled to `dist/`), as types only.

import type { BacklogItem, EditResult, ManifestFile, RemoveItemRequest, SaveItemRequest } from '../../../src/edit.ts';
import type { ItemType } from '../../../src/items.ts';
import type { CustomAttributeSpec } from '../../../src/manifest/project.ts';
import type { ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult } from '../../../src/project-settings.ts';
import type { ProjectDetailReport, StoryStatusEntry } from '../../../src/projects.ts';
import type { Preview, PreviewEpic, PreviewIssue, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict } from '../../../src/review.ts';
import type { CommentAdded, StatusChange } from '../../../src/ticket.ts';
import type { DueStatus, Ticket, TicketsReport } from '../../../src/tickets.ts';

export type { Preview, PreviewEpic, PreviewIssue, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict };
export type { BacklogItem, CustomAttributeSpec, EditResult, ItemType, ManifestFile, RemoveItemRequest, SaveItemRequest };
export type { ProjectDetailReport, ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult };
export type { CommentAdded, DueStatus, StatusChange, StoryStatusEntry, Ticket, TicketsReport };

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

/** The agents the terminal can start in a new tab (quick launch). */
export const TERMINAL_AGENTS = ['claude', 'codex', 'omp'] as const;
export type TerminalAgent = (typeof TERMINAL_AGENTS)[number];
/** `skill` tabs run a given command and are opened by the main process only. */
export type TerminalKind = 'shell' | TerminalAgent | 'skill';

export interface TerminalTab {
  id: number;
  kind: TerminalKind;
  title: string;
  cwd: string;
  pid: number;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
  /** Killed by closing or cancelling the tab, or by quitting. */
  cancelled: boolean;
}

/** The embedded terminal; every tab runs in the open repository. */
export interface TerminalApi {
  /** Opens a shell (pwsh, else powershell.exe; $SHELL elsewhere) or an agent in it; `onOpened` delivers the tab. */
  open(kind: 'shell' | TerminalAgent): Promise<Result<TerminalTab>>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  /** Kills the tab's process tree; the tab stays. */
  cancel(id: number): Promise<void>;
  /** Kills the tab's process tree and forgets the tab. */
  close(id: number): Promise<void>;
  /** A tab was opened, from the renderer or by the main process (e.g. a skill run). */
  onOpened(listener: (tab: TerminalTab) => void): () => void;
  onData(listener: (id: number, data: string) => void): () => void;
  onExit(listener: (id: number, exit: TerminalExit) => void): () => void;
}

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
  /** True when the app opened a terminal tab at the repository for the user to continue there. */
  terminal: boolean;
}

export type GitOutcome = { kind: 'ok'; status: GitStatus; summary?: string } | { kind: 'stopped'; stop: GitStop; status?: GitStatus };

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

/** One row of Taiga > Project: a Taiga project the user is a member of, or a manifest directory not on Taiga yet. */
export interface TaigaProjectRow {
  slug: string;
  /** Taiga's name, else project.yaml's. */
  name?: string;
  /** Set for a project on Taiga (`taigent projects --json`). */
  taiga?: { id: number; admin: boolean };
  /** `<manifests>/<slug>/` exists. */
  manifest: boolean;
  hasProjectYaml: boolean;
  hasBacklog: boolean;
}

export interface TaigaProjectsOverview {
  rows: TaigaProjectRow[];
  /** Why the Taiga projects are missing from `rows` (not logged in, Taiga unreachable…); unset when they are listed. */
  taigaMessage?: string;
}

/** One project opened in Taiga > Project: its project.yaml for the form and, when on Taiga, its issue values. */
export interface TaigaProjectDetail {
  slug: string;
  file: ProjectSettingsFile;
  hasBacklog: boolean;
  /** `taigent projects --project <slug> --json`; unset when the project is not on Taiga or Taiga could not be read. */
  taiga?: ProjectDetailReport;
  taigaMessage?: string;
}

/** A project.yaml save from the form: `slug` unset for a new project (derived from the name). */
export interface ProjectSettingsInput {
  slug?: string;
  settings: ProjectSettings;
  baseDigest: string | null;
}

export interface BootstrapReport {
  project: { id: number; slug: string };
  operations: { action: string; type: string; result: string }[];
  summary: { created: number; updated: number; unchanged: number };
}

export type BootstrapOutcome =
  | { status: 'no-changes' }
  | { status: 'cancelled' }
  | { status: 'bootstrapped'; report: BootstrapReport };

/** Taiga > Ticket của tôi: `tickets --from --to --json`, with the user story statuses of each project holding a ticket. */
export interface MyTickets {
  report: TicketsReport;
  /** By project slug: `projects --project <slug> --json`'s `storyStatuses`, or why they could not be read. */
  statuses: Record<string, { statuses: StoryStatusEntry[] } | { message: string }>;
}

/** One write to a ticket of the user; `subject` and `from` only word the confirmation. */
export interface TicketStatusRequest {
  slug: string;
  ref: number;
  subject: string;
  from: string;
  to: string;
  /** `to` is a closed status: the confirmation says the ticket gets closed. */
  closes: boolean;
}

export interface TicketCommentRequest {
  slug: string;
  ref: number;
  subject: string;
  text: string;
}

export type TicketWriteOutcome<T> = { status: 'cancelled' } | { status: 'done'; value: T };
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
  terminal: TerminalApi;
  /** Reads backlog.yaml for a form, with the fields of item `item` when given (absent when it is not there). */
  readBacklog(slug: string, item?: ItemRef): Promise<Result<BacklogSnapshot>>;
  /** Adds or edits an item; refused (`conflict`) when backlog.yaml is no longer the file `baseDigest` names. */
  saveItem(slug: string, request: SaveItemRequest): Promise<Result<SaveOutcome>>;
  /** Removes an item with its children (a story's tasks); items on Taiga stay there as orphans. */
  removeItem(slug: string, request: RemoveItemRequest): Promise<Result<RemoveOutcome>>;
  /** Taiga > Project: the user's Taiga projects (`taigent projects --json`) and the repository's manifest directories. */
  listTaigaProjects(): Promise<Result<TaigaProjectsOverview>>;
  readTaigaProject(slug: string): Promise<Result<TaigaProjectDetail>>;
  /** Writes the form into project.yaml; refused (`conflict`) when the file is no longer the one `baseDigest` names. */
  saveProjectSettings(input: ProjectSettingsInput): Promise<Result<SaveProjectSettingsResult>>;
  /** `bootstrap --dry-run --json`, a native confirmation listing the operations, then `bootstrap --yes --json`. */
  bootstrapProject(slug: string): Promise<Result<BootstrapOutcome>>;
  /** Status of the opened repository within the Git section's scope. */
  gitStatus(): Promise<Result<GitOutcome>>;
  /** `git pull --ff-only`; stops on a diverged history without touching the working tree. */
  gitPull(): Promise<Result<GitOutcome>>;
  /** Adds and commits exactly the changed files in scope with `message`, then pushes to the upstream. */
  gitCommitPush(message: string): Promise<Result<GitOutcome>>;
  /** Pushes local commits that only touch the scope. */
  gitPush(): Promise<Result<GitOutcome>>;
  /** Taiga > Ticket của tôi: the Period's tickets from `from` to `to` (YYYY-MM-DD, both included). */
  readMyTickets(from: string, to: string): Promise<Result<MyTickets>>;
  /** A native confirmation, then `status --project <slug> --json <ref> -- <to>`. */
  setTicketStatus(request: TicketStatusRequest): Promise<Result<TicketWriteOutcome<StatusChange>>>;
  /** A native confirmation, then `comment --project <slug> --json <ref> -- <text>`. */
  commentTicket(request: TicketCommentRequest): Promise<Result<TicketWriteOutcome<CommentAdded>>>;
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
  terminalOpen: 'taigent:terminal-open',
  terminalWrite: 'taigent:terminal-write',
  terminalResize: 'taigent:terminal-resize',
  terminalCancel: 'taigent:terminal-cancel',
  terminalClose: 'taigent:terminal-close',
  terminalOpened: 'taigent:terminal-opened',
  terminalData: 'taigent:terminal-data',
  terminalExit: 'taigent:terminal-exit',
  readBacklog: 'taigent:read-backlog',
  saveItem: 'taigent:save-item',
  removeItem: 'taigent:remove-item',
  listTaigaProjects: 'taigent:list-taiga-projects',
  readTaigaProject: 'taigent:read-taiga-project',
  saveProjectSettings: 'taigent:save-project-settings',
  bootstrapProject: 'taigent:bootstrap-project',
  gitStatus: 'taigent:git-status',
  gitPull: 'taigent:git-pull',
  gitCommitPush: 'taigent:git-commit-push',
  gitPush: 'taigent:git-push',
  readMyTickets: 'taigent:read-my-tickets',
  setTicketStatus: 'taigent:set-ticket-status',
  commentTicket: 'taigent:comment-ticket',
} as const;

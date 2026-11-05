// The contract between the main process and the renderer: what `window.taigent` (preload) exposes. Review
// shapes, the manifest edit shapes and the upload plan come from taigent's core (`src/review.ts`, `src/edit.ts`,
// `src/upload.ts`, compiled to `dist/`), as types only.

import type { BacklogItem, EditResult, ManifestFile, RemoveItemRequest, SaveItemRequest, SaveWikiPageRequest, WikiPageFile, WikiSnapshot } from '../../../src/edit.ts';
import type { InitFile, InitReport } from '../../../src/init.ts';
import type { ItemType } from '../../../src/items.ts';
import type { CustomAttributeSpec } from '../../../src/manifest/project.ts';
import type { ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult } from '../../../src/project-settings.ts';
import type { MetricsReport } from '../../../src/metrics/compute.ts';
import type { DeveloperItem, MedianDays, WorkloadRow } from '../../../src/metrics/developer.ts';
import type { Period } from '../../../src/metrics/periods.ts';
import type { StaleLink } from '../../../src/planner.ts';
import type { ProjectDetailReport, StoryStatusEntry } from '../../../src/projects.ts';
import type { Preview, PreviewEpic, PreviewIssue, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict } from '../../../src/review.ts';
import type { CommentAdded, StatusChange } from '../../../src/ticket.ts';
import type { DueStatus, Ticket, TicketsReport } from '../../../src/tickets.ts';
import type { UploadOperation, UploadPlan, UploadReport } from '../../../src/upload.ts';

export type { Preview, PreviewEpic, PreviewIssue, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict };
export type { BacklogItem, CustomAttributeSpec, EditResult, ItemType, ManifestFile, RemoveItemRequest, SaveItemRequest };
export type { SaveWikiPageRequest, UploadOperation, UploadPlan, UploadReport, WikiPageFile, WikiSnapshot };
export type { ProjectDetailReport, ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult };
export type { InitFile, InitReport };
export type { CommentAdded, DueStatus, StatusChange, StoryStatusEntry, Ticket, TicketsReport };
export type { DeveloperItem, MedianDays, MetricsReport, Period, WorkloadRow };

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
  staleLinks: StaleLink[];
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

/** The agents the terminal can start in a new tab (the `+` menu). */
export const TERMINAL_AGENTS = ['claude', 'codex', 'omp'] as const;
export type TerminalAgent = (typeof TERMINAL_AGENTS)[number];
/** `skill` tabs run a given command and are opened by the main process only. */
export type TerminalKind = 'shell' | TerminalAgent | 'skill';

/** A shell this machine offers: on Windows PowerShell, Command Prompt and, when installed, Git Bash. */
export interface TerminalShell {
  id: string;
  label: string;
}

export interface TerminalTab {
  id: number;
  kind: TerminalKind;
  title: string;
  cwd: string;
  pid: number;
  /** For a `shell` tab: the id of its TerminalShell. */
  shell?: string;
}

export interface TerminalExit {
  exitCode: number;
  signal?: number;
  /** Killed by closing or cancelling the tab, or by quitting. */
  cancelled: boolean;
}

/** The embedded terminal; every tab runs in the open repository. */
export interface TerminalApi {
  /** The shells this machine offers, the default first (pwsh, else powershell.exe; $SHELL elsewhere). */
  shells(): Promise<TerminalShell[]>;
  /** Opens shell `shell` (default: the default shell) or an agent in the default shell; `onOpened` delivers the tab. */
  open(kind: 'shell' | TerminalAgent, shell?: string): Promise<Result<TerminalTab>>;
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

/** The agents a headless skill run can use (the agent bar and Settings), the default first. */
export const HEADLESS_AGENTS = ['omp', 'claude', 'codex'] as const;
export type HeadlessAgent = (typeof HEADLESS_AGENTS)[number];

/** The app's colours (Settings): follow the OS, or light or dark whatever it says. */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** The Role whose dashboard the Dashboard section shows (GLOSSARY.md, Dashboards); unset until the user picks one. */
export const ROLES = ['developer', 'productOwner', 'businessAnalyst'] as const;
export type Role = (typeof ROLES)[number];

/**
 * The headless buttons, each a `run-skill` of one skill: plan the backlog from a spec file (`taiga-plan-backlog`),
 * answer the open review comments (`taiga-plan-backlog`), write one user story (`taiga-create-user-story`). None
 * applies, uploads or bootstraps.
 */
export type SkillRunRequest =
  | { action: 'plan-spec'; slug?: string }
  | { action: 'review'; slug: string }
  | { action: 'story'; slug: string; description: string };
export type SkillRunAction = SkillRunRequest['action'];

/** A started run: the `skill` tab it runs in. */
export interface SkillRun {
  action: SkillRunAction;
  agent: HeadlessAgent;
  skill: string;
  tabId: number;
}

/** How a run ended; `lastErrorLine` is the last line of output that reads as an error, else its last line. */
export interface SkillRunEnd extends SkillRun {
  exitCode: number;
  cancelled: boolean;
  lastErrorLine?: string;
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

/** A wiki page save (`src/edit.ts`); once saved, `wiki` is docs.yaml and its pages read again. */
export type WikiSaveOutcome = EditResult<{ path: string; page: ManifestFile; wiki: Result<WikiSnapshot> }>;

/** "Đẩy wiki lên Taiga": the dry run found nothing to do, the user cancelled the confirm dialog, or the upload ran. */
export type WikiUploadOutcome = { status: 'no-changes'; plan: UploadPlan } | { status: 'cancelled'; plan: UploadPlan } | { status: 'uploaded'; report: UploadReport };

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

/** The tools the setup checklist looks for on PATH; the app never installs them. */
export const SETUP_TOOLS = ['git', 'claude', 'codex', 'omp'] as const;
export type SetupTool = (typeof SETUP_TOOLS)[number];

/** One tool of the setup checklist, from its `--version` run without a shell. */
export interface ToolCheck {
  tool: SetupTool;
  /**
   * `ok`: `--version` answered (`version`); `missing`: not on PATH; `timeout`: `--version` did not answer in time;
   * `error`: `--version` failed (`message`); `found`: on PATH but its version cannot be read without a shell.
   */
  state: 'ok' | 'missing' | 'timeout' | 'error' | 'found';
  /** Where it was found on PATH. */
  path?: string;
  version?: string;
  message?: string;
  /** The command that installs it, run on request in a terminal tab (`installTool`). */
  install: string;
}

/**
 * Whether the opened repository has Taigent, from `taigent init --dry-run --json` of the app's own taigent:
 * `none` (no Taigent skill yet), `outdated` (init would change files: skills or entries older than the app's),
 * `current` (init would change nothing), `unavailable` (the dry run failed: `message`).
 */
export interface SetupStatus {
  state: 'none' | 'outdated' | 'current' | 'unavailable';
  /** The files init would create, update or remove. */
  changes: InitFile[];
  /** The app's taigent version, the one init installs. */
  taigent: string;
  message?: string;
}

/** A new repository `<parent>/<name>`. */
export interface NewRepoInput {
  parent: string;
  name: string;
}

/** A clone of `url` into `<parent>/<name>`. */
export interface CloneRepoInput {
  url: string;
  parent: string;
  name: string;
}

/** A repository the wizard created and opened, with the outcome of the `taigent init` it ran there. */
export interface CreatedRepo {
  repo: RepoInfo;
  init: Result<InitReport>;
}

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
  /** Reads docs.yaml and its wiki pages' Markdown for the Wiki section. */
  readWiki(slug: string): Promise<Result<WikiSnapshot>>;
  /** Adds or edits a wiki page; refused (`conflict`) when docs.yaml or the page file changed since the form opened. */
  saveWikiPage(slug: string, request: SaveWikiPageRequest): Promise<Result<WikiSaveOutcome>>;
  /** `upload --dry-run`, a confirm dialog listing create/update/skip, then `upload --yes` once confirmed. */
  uploadWiki(slug: string): Promise<Result<WikiUploadOutcome>>;
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
  /** Shows a folder dialog for the folder that holds a new or cloned repository; undefined when cancelled. */
  pickParentFolder(): Promise<string | undefined>;
  /** Creates `<parent>/<name>` with `git init` and `taiga/`, opens it and runs `taigent init` there. */
  createRepo(input: NewRepoInput): Promise<Result<CreatedRepo>>;
  /** `git clone` into `<parent>/<name>` (never prompts), then opens it; a failed clone leaves no folder behind. */
  cloneRepo(input: CloneRepoInput): Promise<Result<RepoInfo>>;
  /** `taigent init --dry-run --json` of the app's taigent on the opened repository. */
  setupStatus(): Promise<Result<SetupStatus>>;
  /** `taigent init --json` of the app's taigent on the opened repository. */
  runInit(): Promise<Result<InitReport>>;
  /** Opens a terminal tab running `npm install` in the opened repository. */
  runNpmInstall(): Promise<Result<TerminalTab>>;
  /** Looks for each of SETUP_TOOLS on PATH and runs its `--version` without a shell, with a timeout. */
  checkTools(): Promise<ToolCheck[]>;
  /** Opens a terminal tab running `tool`'s install command (`ToolCheck.install`). */
  installTool(tool: SetupTool): Promise<Result<TerminalTab>>;
  /** The agent of the headless buttons, from the app settings (default omp). */
  headlessAgent(): Promise<HeadlessAgent>;
  setHeadlessAgent(agent: HeadlessAgent): Promise<Result<HeadlessAgent>>;
  /** The app's colours, from the app settings (default dark); the window and the CSS follow at once. */
  theme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<Result<Theme>>;
  /**
   * Opens a `skill` tab running the bundled `run-skill` in the opened repository; `plan-spec` first asks for the spec
   * file (undefined when that dialog is cancelled). One run at a time.
   */
  runSkill(request: SkillRunRequest): Promise<Result<SkillRun> | undefined>;
  /** A run ended: by itself, failed, or cancelled with Huỷ. */
  onSkillRunEnded(listener: (end: SkillRunEnd) => void): () => void;
  /** Taiga > Ticket của tôi: the Period's tickets from `from` to `to` (YYYY-MM-DD, both included). */
  readMyTickets(from: string, to: string): Promise<Result<MyTickets>>;
  /** A native confirmation, then `status --project <slug> --json <ref> -- <to>`. */
  setTicketStatus(request: TicketStatusRequest): Promise<Result<TicketWriteOutcome<StatusChange>>>;
  /** A native confirmation, then `comment --project <slug> --json <ref> -- <text>`. */
  commentTicket(request: TicketCommentRequest): Promise<Result<TicketWriteOutcome<CommentAdded>>>;
  /** The Role of the Dashboard, from the app settings; null until the user picks one. */
  role(): Promise<Role | null>;
  setRole(role: Role): Promise<Result<Role>>;
  /** The last metrics read of project `slug` that the app saved (shown at once, with its `generatedAt`); null without one. */
  cachedMetrics(slug: string): Promise<Result<MetricsReport | null>>;
  /** Dashboard: `taigent metrics --project <slug> --json` (read-only); a success replaces the saved read. */
  readMetrics(slug: string): Promise<Result<MetricsReport>>;
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
  terminalShells: 'taigent:terminal-shells',
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
  readWiki: 'taigent:read-wiki',
  saveWikiPage: 'taigent:save-wiki-page',
  uploadWiki: 'taigent:upload-wiki',
  listTaigaProjects: 'taigent:list-taiga-projects',
  readTaigaProject: 'taigent:read-taiga-project',
  saveProjectSettings: 'taigent:save-project-settings',
  bootstrapProject: 'taigent:bootstrap-project',
  gitStatus: 'taigent:git-status',
  gitPull: 'taigent:git-pull',
  gitCommitPush: 'taigent:git-commit-push',
  gitPush: 'taigent:git-push',
  pickParentFolder: 'taigent:pick-parent-folder',
  createRepo: 'taigent:create-repo',
  cloneRepo: 'taigent:clone-repo',
  setupStatus: 'taigent:setup-status',
  runInit: 'taigent:run-init',
  runNpmInstall: 'taigent:run-npm-install',
  checkTools: 'taigent:check-tools',
  installTool: 'taigent:install-tool',
  headlessAgent: 'taigent:headless-agent',
  setHeadlessAgent: 'taigent:set-headless-agent',
  theme: 'taigent:theme',
  setTheme: 'taigent:set-theme',
  runSkill: 'taigent:run-skill',
  skillRunEnded: 'taigent:skill-run-ended',
  readMyTickets: 'taigent:read-my-tickets',
  setTicketStatus: 'taigent:set-ticket-status',
  commentTicket: 'taigent:comment-ticket',
  role: 'taigent:role',
  setRole: 'taigent:set-role',
  cachedMetrics: 'taigent:cached-metrics',
  readMetrics: 'taigent:read-metrics',
} as const;

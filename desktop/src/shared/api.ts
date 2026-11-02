// The contract between the main process and the renderer: what `window.taigent` (preload) exposes. Review
// shapes come from taigent's core (`src/review.ts`, compiled to `dist/review.js`), as types only.

import type { ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult } from '../../../src/project-settings.ts';
import type { ProjectDetailReport } from '../../../src/projects.ts';
import type { Preview, PreviewEpic, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict } from '../../../src/review.ts';

export type { Preview, PreviewEpic, PreviewItem, PreviewStory, PreviewSummary, ReviewComment, Verdict };
export type { ProjectDetailReport, ProjectSettings, ProjectSettingsFile, SaveProjectSettingsResult };

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
  /** Taiga > Project: the user's Taiga projects (`taigent projects --json`) and the repository's manifest directories. */
  listTaigaProjects(): Promise<Result<TaigaProjectsOverview>>;
  readTaigaProject(slug: string): Promise<Result<TaigaProjectDetail>>;
  /** Writes the form into project.yaml; refused (`conflict`) when the file is no longer the one `baseDigest` names. */
  saveProjectSettings(input: ProjectSettingsInput): Promise<Result<SaveProjectSettingsResult>>;
  /** `bootstrap --dry-run --json`, a native confirmation listing the operations, then `bootstrap --yes --json`. */
  bootstrapProject(slug: string): Promise<Result<BootstrapOutcome>>;
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
  listTaigaProjects: 'taigent:list-taiga-projects',
  readTaigaProject: 'taigent:read-taiga-project',
  saveProjectSettings: 'taigent:save-project-settings',
  bootstrapProject: 'taigent:bootstrap-project',
} as const;

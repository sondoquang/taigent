// Taiga > Project: the user's Taiga projects (`taigent projects --json`) next to the repository's manifest directories,
// the project.yaml form (taigent's `src/project-settings.ts`, compiled to `dist/project-settings.js`), and bootstrap:
// `bootstrap --dry-run --json`, a native confirmation listing what it would do, then `bootstrap --yes --json`.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type BrowserWindow, dialog } from 'electron';
import { PROJECT_SLUG_PATTERN } from '../../../src/manifest/conventions.ts';
import type * as ProjectSettingsModule from '../../../src/project-settings.ts';
import type { ProjectDetailReport, ProjectsReport } from '../../../src/projects.ts';
import type {
  BootstrapOutcome,
  BootstrapReport,
  ProjectSettingsInput,
  Result,
  SaveProjectSettingsResult,
  TaigaProjectDetail,
  TaigaProjectRow,
  TaigaProjectsOverview,
} from '../shared/api.ts';
import { failure, messageOf } from './project.ts';
import { manifestsDir } from './repo.ts';
import { networkFix, taigaFailure } from './taiga-errors.ts';
import { type CliError, parseCliJson, runCli, taigentRoot } from './taigent.ts';

let settingsModule: Promise<typeof ProjectSettingsModule> | undefined;

/** taigent's project.yaml form API, loaded once from its compiled core. */
function projectSettings(): Promise<typeof ProjectSettingsModule> {
  settingsModule ??= import(pathToFileURL(join(taigentRoot(), 'dist', 'project-settings.js')).href).catch((error: unknown) => {
    settingsModule = undefined;
    throw new Error(`Không nạp được lõi taigent (${messageOf(error)}). Chạy \`npm run build\` ở thư mục gốc của taigent.`, { cause: error });
  });
  return settingsModule;
}

const isFile = (path: string) => stat(path).then((s) => s.isFile(), () => false);

/**
 * The CLI's error as the Project screen says it (one line, no Failure detail), in Vietnamese with how to fix it; an
 * error other than the login ones ends with the CLI's own message.
 */
function taigaMessage(error: CliError | undefined): string {
  const failed = `Không đọc được các project trên Taiga. ${networkFix()}`;
  const { message, detail } = taigaFailure(error, { failed });
  return message === failed && detail ? `${message} Chi tiết: ${detail}` : message;
}

export async function listTaigaProjects(root: string): Promise<Result<TaigaProjectsOverview>> {
  const dir = manifestsDir(root);
  const [run, entries, settings] = await Promise.all([
    runCli(['projects', '--json'], root),
    readdir(dir, { withFileTypes: true }).catch(() => []),
    projectSettings(),
  ]);
  const local = new Map<string, TaigaProjectRow>();
  for (const entry of entries.filter((e) => e.isDirectory() && PROJECT_SLUG_PATTERN.test(e.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const slug = entry.name;
    const file = await settings.readProjectSettings(dir, slug);
    local.set(slug, {
      slug,
      ...(file.settings?.name && { name: file.settings.name }),
      manifest: true,
      hasProjectYaml: file.digest !== null,
      hasBacklog: await isFile(join(dir, slug, 'backlog.yaml')),
    });
  }
  const { value, error } = parseCliJson<ProjectsReport>(run);
  if (!value) return { ok: true, value: { rows: [...local.values()], taigaMessage: taigaMessage(error) } };
  const rows: TaigaProjectRow[] = value.projects.map((project) => {
    const manifest = local.get(project.slug);
    local.delete(project.slug);
    return {
      slug: project.slug,
      name: project.name,
      taiga: { id: project.id, admin: project.admin },
      manifest: project.manifest,
      hasProjectYaml: manifest?.hasProjectYaml ?? false,
      hasBacklog: manifest?.hasBacklog ?? false,
    };
  });
  return { ok: true, value: { rows: [...rows, ...local.values()] } };
}

export async function readTaigaProject(root: string, slug: string): Promise<Result<TaigaProjectDetail>> {
  const dir = manifestsDir(root);
  const [file, hasBacklog, run] = await Promise.all([
    projectSettings().then((settings) => settings.readProjectSettings(dir, slug)),
    isFile(join(dir, slug, 'backlog.yaml')),
    runCli(['projects', '--project', slug, '--json'], root),
  ]);
  const { value, error } = parseCliJson<ProjectDetailReport>(run);
  if (value) return { ok: true, value: { slug, file, hasBacklog, taiga: value } };
  const notOnTaiga = error?.kind === 'taiga' && /not found/.test(error.message);
  const message = notOnTaiga ? 'Chưa có trên Taiga (hoặc bạn không xem được project này): bootstrap sẽ tạo project.' : taigaMessage(error);
  return { ok: true, value: { slug, file, hasBacklog, taigaMessage: message } };
}

export async function saveProjectFile(root: string, input: ProjectSettingsInput): Promise<Result<SaveProjectSettingsResult>> {
  const settings = await projectSettings();
  const options = input.slug === undefined ? { baseDigest: input.baseDigest } : { slug: input.slug, baseDigest: input.baseDigest };
  return { ok: true, value: await settings.saveProjectSettings(manifestsDir(root), input.settings, options) };
}

/** One operation of a `BootstrapPlan` (docs/cli.md § Bootstrap) as a line of the confirmation. */
interface BootstrapOperation {
  action: 'create' | 'update' | 'skip';
  type: string;
  name?: string;
  color?: string;
  template?: string;
  modules?: string[];
  itemType?: string;
  member?: string;
  role?: string;
  slug?: string;
  fields?: { name?: string };
}

interface BootstrapPlan {
  project: { id: number | null; slug: string; name: string; exists: boolean };
  changes: boolean;
  summary: { create: number; update: number; skip: number };
  operations: BootstrapOperation[];
}

function describeOperation(op: BootstrapOperation): string {
  switch (op.type) {
    case 'project':
      return `Tạo project ${op.fields?.name ?? ''} (template ${op.template ?? '?'})`;
    case 'modules':
      return `Bật module: ${(op.modules ?? []).join(', ')}`;
    case 'tag':
      return op.action === 'create' ? `Tạo tag ${op.name} (${op.color})` : `Đổi màu tag ${op.name} thành ${op.color}`;
    case 'custom-attribute':
      return `Tạo custom attribute ${op.itemType}: ${op.name}`;
    case 'membership':
      return `Mời ${op.member} (vai trò ${op.role})`;
    case 'wiki':
      return `Tạo trang wiki ${op.slug}`;
    default:
      return `${op.action} ${op.type}`;
  }
}

/**
 * "Bootstrap lên Taiga": `bootstrap --dry-run --json`; without changes it stops there. With changes, a native dialog
 * lists them, and only its "Bootstrap" button runs `bootstrap --yes --json` (conventions §1: the explicit approval).
 */
export async function bootstrapProject(root: string, slug: string, window: BrowserWindow): Promise<Result<BootstrapOutcome>> {
  const dry = await runCli(['bootstrap', '--project', slug, '--dry-run', '--json'], root);
  const planned = parseCliJson<BootstrapPlan>(dry);
  if (!planned.value) return failure('Không chạy được bootstrap --dry-run.', { detail: planned.error?.message, issues: planned.error?.issues });
  const plan = planned.value;
  if (!plan.changes) return { ok: true, value: { status: 'no-changes' } };

  const changes = plan.operations.filter((op) => op.action !== 'skip');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Bootstrap project',
    message: plan.project.exists ? `Bổ sung project ${plan.project.name} trên Taiga?` : `Tạo project ${plan.project.name} trên Taiga?`,
    detail: [`Dự án: ${slug}`, `Tạo mới: ${plan.summary.create}, cập nhật: ${plan.summary.update}`, '', ...changes.map((op) => `• ${describeOperation(op)}`)].join('\n'),
    buttons: ['Bootstrap', 'Huỷ'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { ok: true, value: { status: 'cancelled' } };

  const run = await runCli(['bootstrap', '--project', slug, '--yes', '--json'], root);
  const { value, error } = parseCliJson<BootstrapReport>(run);
  if (value && run.code === 0) return { ok: true, value: { status: 'bootstrapped', report: value } };
  return failure('Bootstrap thất bại; những gì đã tạo được lưu trong state.json, chạy lại sẽ chỉ bổ sung phần còn thiếu.', {
    detail: error?.message,
    issues: error?.issues,
  });
}

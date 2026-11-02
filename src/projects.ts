// The read-only `projects` command: the Taiga projects the user is a member of, whether the repository holds their
// manifests (`<manifests root>/<slug>/`), and for one project the issue values a backlog issue may name.

import { stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isFileNotFound } from './guards.ts';
import type { IssueValueField } from './items.ts';
import { type TaigaClient, TaigaError } from './taiga/client.ts';

/** One Taiga project as `projects` reports it. */
export interface ProjectEntry {
  id: number;
  slug: string;
  name: string;
  /** The user is an admin of the project (`i_am_admin`): bootstrap needs it. */
  admin: boolean;
  /** `<manifests root>/<slug>/` exists in the repository. */
  manifest: boolean;
}

export interface ProjectsReport {
  projects: ProjectEntry[];
}

/** `projects --project <slug>`: the project and the names of its issue values, in Taiga's order. */
export interface ProjectDetailReport {
  project: ProjectEntry;
  issueTypes: string[];
  severities: string[];
  priorities: string[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

/** Every project the logged-in user is a member of, in Taiga's order; `manifestsRoot` is the absolute manifests root. */
export async function readProjects(client: TaigaClient, manifestsRoot: string): Promise<ProjectsReport> {
  const me = await client.getMe();
  const projects = await client.listMemberProjects(me.id);
  return {
    projects: await Promise.all(
      projects.map(async ({ id, slug, name, iAmAdmin }) => ({ id, slug, name, admin: iAmAdmin, manifest: await isDirectory(join(manifestsRoot, slug)) })),
    ),
  };
}

/** One visible project with its issue types, severities and priorities; exit 5 (TaigaError) when it is not visible. */
export async function readProjectDetail(client: TaigaClient, slug: string, manifestsRoot: string): Promise<ProjectDetailReport> {
  const project = await client.findProjectBySlug(slug);
  if (!project) throw new TaigaError(`project "${slug}" not found on ${client.apiUrl} (or not visible to this user)`, 404);
  const names = (field: IssueValueField) => client.listIssueValues(field, project.id).then((values) => values.map((value) => value.name));
  const [issueTypes, severities, priorities] = await Promise.all([names('type'), names('severity'), names('priority')]);
  return {
    project: { id: project.id, slug: project.slug, name: project.name, admin: project.iAmAdmin, manifest: await isDirectory(join(manifestsRoot, project.slug)) },
    issueTypes,
    severities,
    priorities,
  };
}

function describeProject(project: ProjectEntry, manifestsRoot: string, cwd: string): string {
  const rights = project.admin ? `id ${project.id}, admin` : `id ${project.id}`;
  const manifest = project.manifest ? `manifest ${relative(cwd, join(manifestsRoot, project.slug))}` : 'no manifest';
  return `${project.slug}  ${project.name}  (${rights})  ${manifest}`;
}

export function formatProjectsText(report: ProjectsReport, manifestsRoot: string, cwd: string): string {
  if (report.projects.length === 0) return 'You are not a member of any Taiga project.\n';
  const lines = report.projects.map((project) => `  ${describeProject(project, manifestsRoot, cwd)}`);
  return `Taiga projects you are a member of (${report.projects.length}):\n${lines.join('\n')}\n`;
}

export function formatProjectDetailText(report: ProjectDetailReport, manifestsRoot: string, cwd: string): string {
  const list = (names: string[]) => (names.length > 0 ? names.join(', ') : '(none)');
  return [
    `Project ${describeProject(report.project, manifestsRoot, cwd)}`,
    `Issue types: ${list(report.issueTypes)}`,
    `Severities: ${list(report.severities)}`,
    `Priorities: ${list(report.priorities)}`,
    '',
  ].join('\n');
}

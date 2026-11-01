// Bootstrap: brings a Taiga project to the state declared in project.yaml. `planBootstrap` is pure: from
// the manifest and what Taiga reports it derives an ordered list of operations that only fill gaps
// (create the project, enable modules, create/color tags, create custom attributes, invite members, create
// the wiki home). It never disables, renames or deletes anything. `executeBootstrap` runs that plan.

import { WIKI_HOME_SLUG, type ProjectModule } from './manifest/conventions.ts';
import type { CustomAttributeItemType, CustomAttributeSpec, ProjectManifest } from './manifest/project.ts';
import { readState, writeState } from './manifest/state.ts';
import {
  TaigaError,
  type ModuleFlag,
  type NewProject,
  type TaigaClient,
  type TaigaMembership,
  type TaigaProjectDetail,
  type TaigaProjectTemplate,
  type TaigaUser,
} from './taiga/client.ts';

/** What Taiga currently has, as read by the CLI before planning. */
export interface BootstrapRemote {
  me: TaigaUser;
  /** The existing project matched by slug, if any. */
  project?: TaigaProjectDetail;
  /** The manifest's template; required when the project does not exist yet. */
  template?: TaigaProjectTemplate;
  /** Memberships of the existing project (empty for a new one). */
  memberships: TaigaMembership[];
  wikiHomeExists: boolean;
}

export type BootstrapOperation =
  | { action: 'create'; type: 'project'; template: string; fields: NewProject }
  | { action: 'skip'; type: 'project'; id: number; slug: string }
  | { action: 'update'; type: 'modules'; modules: ProjectModule[]; fields: Partial<Record<ModuleFlag, true>> }
  | { action: 'skip'; type: 'modules'; modules: ProjectModule[] }
  | { action: 'create' | 'skip'; type: 'tag'; name: string; color: string }
  | { action: 'update'; type: 'tag'; name: string; color: string; current: string | null }
  | { action: 'create' | 'skip'; type: 'custom-attribute'; itemType: CustomAttributeItemType; name: string; fields: CustomAttributeSpec }
  | { action: 'create' | 'skip'; type: 'membership'; member: string; role: string }
  | { action: 'create'; type: 'wiki'; slug: string; content: string }
  | { action: 'skip'; type: 'wiki'; slug: string };

export interface BootstrapPlan {
  project: { id: number | null; slug: string; name: string; exists: boolean };
  changes: boolean;
  summary: { create: number; update: number; skip: number };
  operations: BootstrapOperation[];
}

export type BootstrapResult = 'created' | 'updated' | 'unchanged';

export interface BootstrapReport {
  project: { id: number; slug: string };
  operations: (BootstrapOperation & { result: BootstrapResult })[];
  summary: Record<BootstrapResult, number>;
}

const moduleFlag = (module: ProjectModule) => `is_${module}_activated` as ModuleFlag;

/** Finds the template the manifest names (`scrum`, `kanban`) among Taiga's, by slug or name. */
export function findTemplate(templates: TaigaProjectTemplate[], name: string): TaigaProjectTemplate {
  const wanted = name.toLowerCase();
  const template = templates.find((t) => t.slug === wanted || t.name.toLowerCase() === wanted);
  if (!template) {
    throw new TaigaError(`project template "${name}" not found on Taiga; available: ${templates.map((t) => t.slug).join(', ') || '(none)'}`);
  }
  return template;
}

export function planBootstrap(manifest: ProjectManifest, remote: BootstrapRemote): BootstrapPlan {
  const { project, me } = remote;
  if (project && !project.iAmAdmin) {
    throw new TaigaError(
      `project "${project.slug}" already exists and you (${me.username}) are not an admin of it; refusing to bootstrap it. ` +
        'Ask a project admin to run bootstrap or to make you an admin.',
      403,
    );
  }
  if (!project && !remote.template) throw new Error('planBootstrap: a template is required to create the project');

  const operations: BootstrapOperation[] = [];
  operations.push(
    project
      ? { action: 'skip', type: 'project', id: project.id, slug: project.slug }
      : {
          action: 'create',
          type: 'project',
          template: manifest.template,
          fields: { name: manifest.name, description: manifest.description, creation_template: remote.template!.id, is_private: manifest.isPrivate },
        },
  );

  const currentModules = project?.modules ?? remote.template!.modules;
  const missingModules = manifest.modules.filter((module) => !currentModules[moduleFlag(module)]);
  operations.push(
    missingModules.length > 0
      ? { action: 'update', type: 'modules', modules: missingModules, fields: Object.fromEntries(missingModules.map((m) => [moduleFlag(m), true])) }
      : { action: 'skip', type: 'modules', modules: manifest.modules },
  );

  const tagsColors = project?.tagsColors ?? {};
  for (const { name, color } of manifest.tags) {
    if (!Object.hasOwn(tagsColors, name)) operations.push({ action: 'create', type: 'tag', name, color });
    else if (tagsColors[name]?.toUpperCase() !== color) operations.push({ action: 'update', type: 'tag', name, color, current: tagsColors[name] ?? null });
    else operations.push({ action: 'skip', type: 'tag', name, color });
  }

  for (const itemType of ['epic', 'userstory', 'task'] as const) {
    const existing = new Set(project?.customAttributes[itemType].map((a) => a.name));
    for (const fields of manifest.customAttributes[itemType]) {
      operations.push({ action: existing.has(fields.name) ? 'skip' : 'create', type: 'custom-attribute', itemType, name: fields.name, fields });
    }
  }

  const roles = project?.roles ?? remote.template!.roles;
  const rolesOwner = project ? `project ${project.slug}` : `template ${manifest.template}`;
  const usernames = new Set((project?.members ?? [me]).map((m) => m.username.toLowerCase()));
  const emails = new Set(
    (project ? remote.memberships.flatMap((m) => [m.email, m.userEmail]) : [me.email]).filter((e) => e !== null).map((e) => e.toLowerCase()),
  );
  const roleErrors: string[] = [];
  for (const spec of manifest.members) {
    const member = (spec.username ?? spec.email)!;
    const wanted = spec.role.toLowerCase();
    const role = roles.find((r) => r.name.toLowerCase() === wanted || r.slug === wanted);
    if (!role) {
      roleErrors.push(`role "${spec.role}" (member ${member}) does not exist in ${rolesOwner}; roles: ${roles.map((r) => r.name).join(', ')}`);
      continue;
    }
    const isMember = spec.username !== undefined ? usernames.has(spec.username.toLowerCase()) : emails.has(spec.email!.toLowerCase());
    operations.push({ action: isMember ? 'skip' : 'create', type: 'membership', member, role: role.name });
  }
  if (roleErrors.length > 0) throw new TaigaError(roleErrors.join('\n'));

  if (manifest.wikiHome !== undefined) {
    operations.push(
      remote.wikiHomeExists
        ? { action: 'skip', type: 'wiki', slug: WIKI_HOME_SLUG }
        : { action: 'create', type: 'wiki', slug: WIKI_HOME_SLUG, content: manifest.wikiHome },
    );
  }

  const summary = { create: 0, update: 0, skip: 0 };
  for (const op of operations) summary[op.action] += 1;
  return {
    project: { id: project?.id ?? null, slug: manifest.slug, name: manifest.name, exists: project !== undefined },
    changes: summary.create + summary.update > 0,
    summary,
    operations,
  };
}

/** Human-readable description of one operation, shared by the plan and the report. */
export function describeOperation(op: BootstrapOperation): string {
  switch (op.type) {
    case 'project':
      return op.action === 'create'
        ? `create project "${op.fields.name}"  (template ${op.template}, ${op.fields.is_private ? 'private' : 'public'})`
        : `project ${op.slug} (id ${op.id}, exists)`;
    case 'modules':
      return op.action === 'update' ? `enable modules ${op.modules.join(', ')}` : `modules ${op.modules.join(', ')} (enabled)`;
    case 'tag':
      if (op.action === 'update') return `set tag color ${op.name}  ${op.color} (was ${op.current ?? 'none'})`;
      return op.action === 'create' ? `create tag ${op.name}  ${op.color}` : `tag ${op.name}  ${op.color}`;
    case 'custom-attribute':
      return op.action === 'create'
        ? `create ${op.itemType} custom attribute "${op.name}" (${op.fields.type})`
        : `${op.itemType} custom attribute "${op.name}"`;
    case 'membership':
      return op.action === 'create' ? `invite ${op.member} as ${op.role}` : `member ${op.member} (already a member)`;
    case 'wiki':
      return op.action === 'create' ? `create wiki page ${op.slug}` : `wiki page ${op.slug} (exists)`;
  }
}

/**
 * Runs the plan. The project id/slug is written to the state file as soon as the project exists, so a
 * failed run is resumed (matched by slug, or by the recorded id) instead of creating a second project.
 */
export async function executeBootstrap(
  plan: BootstrapPlan,
  existing: TaigaProjectDetail | undefined,
  client: TaigaClient,
  statePath: string,
): Promise<BootstrapReport> {
  let project = existing;
  const saveProject = async (detail: TaigaProjectDetail) => {
    const state = await readState(statePath, { id: detail.id, slug: detail.slug });
    await writeState(statePath, state);
  };
  const operations: BootstrapReport['operations'] = [];
  const summary: Record<BootstrapResult, number> = { created: 0, updated: 0, unchanged: 0 };

  for (const op of plan.operations) {
    const result: BootstrapResult = op.action === 'create' ? 'created' : op.action === 'update' ? 'updated' : 'unchanged';
    try {
      if (op.type === 'project' && op.action === 'create') {
        project = await client.createProject(op.fields);
        await saveProject(project);
        if (project.slug !== plan.project.slug) {
          throw new TaigaError(
            `Taiga created the project with slug "${project.slug}" instead of "${plan.project.slug}" (Taiga derives slugs from the ` +
              'name and may prefix the owner username, DEFAULT_PROJECT_SLUG_PREFIX). Its id ' +
              `${project.id} is recorded in state.json, so re-running will not create another project. Have a Taiga admin set ` +
              `the slug to "${plan.project.slug}", then re-run bootstrap.`,
          );
        }
      } else if (op.action !== 'skip') {
        const target = project!;
        switch (op.type) {
          case 'modules':
            project = await client.updateProjectModules(target.id, op.fields);
            break;
          case 'tag':
            if (op.action === 'create') await client.createTag(target.id, op.name, op.color);
            else await client.setTagColor(target.id, op.name, op.color);
            break;
          case 'custom-attribute':
            await client.createCustomAttribute(op.itemType, { project: target.id, ...op.fields });
            break;
          case 'membership': {
            const role = target.roles.find((r) => r.name === op.role);
            if (!role) throw new TaigaError(`role "${op.role}" not found in project ${target.slug}`);
            await client.createMembership({ project: target.id, role: role.id, username: op.member });
            break;
          }
          case 'wiki':
            if (op.action === 'create') await client.createWikiPage({ project: target.id, slug: op.slug, content: op.content });
            break;
        }
      }
    } catch (error) {
      if (!(error instanceof TaigaError)) throw error;
      throw new TaigaError(`bootstrap step "${describeOperation(op)}" failed: ${error.message}`, error.status);
    }
    operations.push({ ...op, result });
    summary[result] += 1;
  }

  await saveProject(project!);
  return { project: { id: project!.id, slug: project!.slug }, operations, summary };
}

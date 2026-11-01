// In-process fake of the Taiga REST API (https://docs.taiga.io/api.html).
// It is the single test seam for talking to Taiga: tests point TAIGA_API_URL at
// `fake.url` and assert on `fake.state` afterwards. Extend it (endpoints, hooks)
// instead of mocking internal modules.
//
// Fidelity rules (mirroring taiga-back):
// - Every route lives under /api/v1; everything except POST /auth needs `Authorization: Bearer <token>`.
// - Lists are paginated (30 per page, `x-pagination-*` headers) unless `x-disable-pagination` is sent.
// - Tags are stored lowercased and returned as `[name, color|null]` pairs.
// - Validation errors are 400 with DRF-style `{ field: [message] }` bodies. The fake is STRICTER than
//   Taiga on one point: unknown payload fields are rejected (Taiga silently ignores them), so typos
//   such as `project_id` instead of `project` fail loudly in tests.

import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PAGE_SIZE = 30;

export interface FakeUser {
  id: number;
  username: string;
  password: string;
  email?: string;
}

/** Module flags of a project or template (`is_<module>_activated`). */
export interface FakeModules {
  is_epics_activated: boolean;
  is_backlog_activated: boolean;
  is_kanban_activated: boolean;
  is_issues_activated: boolean;
  is_wiki_activated: boolean;
}

export interface FakeRole {
  id: number;
  project: number;
  name: string;
  slug: string;
}

export interface FakeTemplate {
  id: number;
  name: string;
  slug: string;
  modules: FakeModules;
  /** Roles copied into a project created from this template; the first is the owner's (`default_owner_role`). */
  roles: { name: string; slug: string }[];
}

export type FakeCustomAttributeType = 'epic' | 'userstory' | 'task';

export interface FakeCustomAttribute {
  id: number;
  itemType: FakeCustomAttributeType;
  project: number;
  name: string;
  description: string;
  type: string;
  order: number;
}

export interface FakeMembership {
  id: number;
  project: number;
  role: number;
  /** Null for a pending e-mail invitation of someone without a Taiga account. */
  user: number | null;
  email: string | null;
}

export interface FakeWikiPage {
  id: number;
  project: number;
  slug: string;
  content: string;
  version: number;
}

export interface FakeProject {
  id: number;
  slug: string;
  name: string;
  members: number[];
  /** Shared ref sequence for epics/stories/tasks, like Taiga's per-project refs. */
  lastRef: number;
  description: string;
  is_private: boolean;
  creation_template: number | null;
  /** Members with project-admin rights (`i_am_admin`). */
  admins: number[];
  modules: FakeModules;
  /** Explicit tag colors (create_tag/edit_tag); tags used by items are added with a null color. */
  tagsColors: Record<string, string | null>;
}

export interface FakeEpic {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
}

export interface FakeState {
  users: FakeUser[];
  projects: FakeProject[];
  epics: FakeEpic[];
  templates: FakeTemplate[];
  roles: FakeRole[];
  customAttributes: FakeCustomAttribute[];
  memberships: FakeMembership[];
  wikiPages: FakeWikiPage[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface InterceptRule {
  method: string;
  /** Path below /api/v1, e.g. `/epics` or a RegExp matched against it. */
  path: string | RegExp;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** How many matching requests to let through untouched before intercepting (default 0). */
  after?: number;
  /** How many matching requests to intercept (default 1). */
  times?: number;
}

export interface FakeTaiga {
  /** Value for TAIGA_API_URL (includes /api/v1, like the real instance). */
  url: string;
  state: FakeState;
  /** Every request received, in order (POST /auth bodies included; do not print them). */
  requests: RecordedRequest[];
  /** Default credentials accepted by POST /auth. */
  user: FakeUser;
  /** Instance settings. `projectSlugPrefix` mirrors taiga-back's DEFAULT_PROJECT_SLUG_PREFIX (slug = owner-name). */
  settings: { projectSlugPrefix: boolean };
  addProject(input: {
    slug: string;
    name?: string;
    members?: number[];
    /** Default: every member is admin. */
    admins?: number[];
    is_private?: boolean;
    /** Default: scrum template roles; modules default to all enabled. */
    modules?: Partial<FakeModules>;
    tagsColors?: Record<string, string | null>;
  }): FakeProject;
  addEpic(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeEpic;
  addUser(input: { username: string; email?: string }): FakeUser;
  addCustomAttribute(input: { itemType: FakeCustomAttributeType; project: number; name: string; description?: string; type?: string }): FakeCustomAttribute;
  /** Adds a membership; an existing user (by id) also becomes a project member. */
  addMembership(input: { project: number; role: string; user?: number; email?: string }): FakeMembership;
  addWikiPage(input: { project: number; slug: string; content: string }): FakeWikiPage;
  /** Answer the next matching request(s) with a canned response instead of handling it. */
  intercept(rule: InterceptRule): void;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  readonly reply: Reply;
  constructor(status: number, body: unknown) {
    super(`fake taiga ${status}`);
    this.reply = { status, body };
  }
}

const notFound = () => new HttpError(404, { _error_message: 'No matches the given query.', _error_type: 'taiga.base.exceptions.NotFound' });
const fieldErrors = (errors: Record<string, string[]>) => new HttpError(400, errors);

const EPIC_FIELDS: Record<string, true> = {
  project: true, subject: true, description: true, tags: true, assigned_to: true, status: true, color: true,
  client_requirement: true, team_requirement: true, is_blocked: true, blocked_note: true, epics_order: true,
  watchers: true,
};

/** Fields accepted by POST /projects and PATCH /projects/{id} (docs §10.2/10.5; `slug` is read-only in taiga-back). */
const PROJECT_FIELDS: Record<string, true> = {
  name: true, description: true, creation_template: true, is_backlog_activated: true, is_issues_activated: true,
  is_kanban_activated: true, is_private: true, is_wiki_activated: true, is_epics_activated: true, videoconferences: true,
  videoconferences_extra_data: true, total_milestones: true, total_story_points: true,
};

const MODULE_FLAGS = ['is_epics_activated', 'is_backlog_activated', 'is_kanban_activated', 'is_issues_activated', 'is_wiki_activated'] as const;

const CUSTOM_ATTRIBUTE_FIELDS: Record<string, true> = { name: true, description: true, order: true, project: true, type: true, extra: true };
/** taiga-back custom attribute types (`dropdown` needs `extra` options). */
const CUSTOM_ATTRIBUTE_TYPES = ['text', 'multiline', 'richtext', 'date', 'url', 'dropdown', 'checkbox', 'number'];

const HEX_COLOR = /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/;

const SCRUM_ROLES = [
  { name: 'Product Owner', slug: 'product-owner' },
  { name: 'UX', slug: 'ux' },
  { name: 'Design', slug: 'design' },
  { name: 'Front', slug: 'front' },
  { name: 'Back', slug: 'back' },
  { name: 'Stakeholder', slug: 'stakeholder' },
];

/** taiga-back `slugify`: django slugify after unidecode (approximated: strip diacritics, đ → d). */
export function taigaSlugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[-\s]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

const permissionDenied = () =>
  new HttpError(403, { _error_message: 'You do not have permission to perform this action.', _error_type: 'taiga.base.exceptions.PermissionDenied' });

function unknownFields(data: Json, allowed: Record<string, true>, errors: Record<string, string[]>): void {
  for (const field of Object.keys(data)) {
    if (!Object.hasOwn(allowed, field)) errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
  }
}

function requireObject(body: unknown): Json {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fieldErrors({ non_field_errors: ['Invalid data'] });
  return body as Json;
}

export async function startFakeTaiga(): Promise<FakeTaiga> {
  const user: FakeUser = { id: 1, username: 'taigent-bot', password: 'fake-password-123', email: 'taigent-bot@example.test' };
  const state: FakeState = {
    users: [user],
    projects: [],
    epics: [],
    templates: [
      {
        id: 1,
        name: 'Scrum',
        slug: 'scrum',
        modules: { is_epics_activated: false, is_backlog_activated: true, is_kanban_activated: false, is_issues_activated: true, is_wiki_activated: true },
        roles: SCRUM_ROLES,
      },
      {
        id: 2,
        name: 'Kanban',
        slug: 'kanban',
        modules: { is_epics_activated: false, is_backlog_activated: false, is_kanban_activated: true, is_issues_activated: false, is_wiki_activated: false },
        roles: SCRUM_ROLES,
      },
    ],
    roles: [],
    customAttributes: [],
    memberships: [],
    wikiPages: [],
  };
  const settings = { projectSlugPrefix: false };
  const requests: RecordedRequest[] = [];
  const intercepts: InterceptRule[] = [];
  const tokens = new Map<string, number>();
  let nextId = 1000;

  function addRoles(project: FakeProject, roles: { name: string; slug: string }[]): void {
    for (const role of roles) state.roles.push({ id: ++nextId, project: project.id, name: role.name, slug: role.slug });
  }

  function findRole(projectId: number, nameOrSlug: string): FakeRole | undefined {
    return state.roles.find((r) => r.project === projectId && (r.name === nameOrSlug || r.slug === nameOrSlug));
  }

  function addProject(input: Parameters<FakeTaiga['addProject']>[0]): FakeProject {
    const members = input.members ?? [user.id];
    const project: FakeProject = {
      id: ++nextId,
      slug: input.slug,
      name: input.name ?? input.slug,
      members: [],
      lastRef: 0,
      description: '',
      is_private: input.is_private ?? true,
      creation_template: null,
      admins: input.admins ?? members,
      modules: { is_epics_activated: true, is_backlog_activated: true, is_kanban_activated: true, is_issues_activated: true, is_wiki_activated: true, ...input.modules },
      tagsColors: { ...input.tagsColors },
    };
    state.projects.push(project);
    addRoles(project, SCRUM_ROLES);
    for (const member of members) addMembership({ project: project.id, role: 'product-owner', user: member });
    return project;
  }

  function addUser(input: { username: string; email?: string }): FakeUser {
    const added: FakeUser = { id: ++nextId, username: input.username, password: `pw-${input.username}`, email: input.email };
    state.users.push(added);
    return added;
  }

  function addMembership(input: { project: number; role: string; user?: number; email?: string }): FakeMembership {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const role = findRole(project.id, input.role);
    if (!role) throw new Error(`fake taiga: no role ${input.role} in project ${project.id}`);
    const membership: FakeMembership = { id: ++nextId, project: project.id, role: role.id, user: input.user ?? null, email: input.email ?? null };
    state.memberships.push(membership);
    if (input.user !== undefined && !project.members.includes(input.user)) project.members.push(input.user);
    return membership;
  }

  function addCustomAttribute(input: { itemType: FakeCustomAttributeType; project: number; name: string; description?: string; type?: string }): FakeCustomAttribute {
    const order = state.customAttributes.filter((a) => a.project === input.project && a.itemType === input.itemType).length + 1;
    const attribute: FakeCustomAttribute = {
      id: ++nextId,
      itemType: input.itemType,
      project: input.project,
      name: input.name,
      description: input.description ?? '',
      type: input.type ?? 'text',
      order,
    };
    state.customAttributes.push(attribute);
    return attribute;
  }

  function addWikiPage(input: { project: number; slug: string; content: string }): FakeWikiPage {
    const page: FakeWikiPage = { id: ++nextId, project: input.project, slug: input.slug, content: input.content, version: 1 };
    state.wikiPages.push(page);
    return page;
  }

  function addEpic(input: { project: number; subject: string; description?: string; tags?: string[] }): FakeEpic {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const epic: FakeEpic = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
    };
    state.epics.push(epic);
    return epic;
  }

  function epicJson(epic: FakeEpic): Json {
    return { ...epic, tags: epic.tags.map((t) => [t, null]) };
  }

  /** Tags of the project (`tags_colors`): explicit colors plus tags used by items (null color), like taiga-back. */
  function projectTagsColors(project: FakeProject): Record<string, string | null> {
    const colors: Record<string, string | null> = {};
    for (const epic of state.epics) if (epic.project === project.id) for (const tag of epic.tags) colors[tag] = null;
    return { ...colors, ...project.tagsColors };
  }

  function customAttributeJson(attribute: FakeCustomAttribute): Json {
    const { itemType: _itemType, ...rest } = attribute;
    return { ...rest, extra: null };
  }

  /** Project detail object (docs §48.2), limited to the fields taigent reads. */
  function projectJson(project: FakeProject, userId: number): Json {
    const attributes = (itemType: FakeCustomAttributeType) =>
      state.customAttributes.filter((a) => a.project === project.id && a.itemType === itemType).map(customAttributeJson);
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      is_private: project.is_private,
      creation_template: project.creation_template,
      i_am_member: project.members.includes(userId),
      i_am_admin: project.members.includes(userId) && project.admins.includes(userId),
      ...project.modules,
      tags_colors: projectTagsColors(project),
      roles: state.roles.filter((r) => r.project === project.id).map(({ id, name, slug }) => ({ id, name, slug, project: project.id })),
      members: project.members.map((id) => {
        const member = state.users.find((u) => u.id === id)!;
        const role = state.roles.find((r) => r.id === state.memberships.find((m) => m.project === project.id && m.user === id)?.role);
        return { id, username: member.username, full_name: member.username, role: role?.id ?? null, role_name: role?.name ?? null, is_active: true };
      }),
      epic_custom_attributes: attributes('epic'),
      userstory_custom_attributes: attributes('userstory'),
      task_custom_attributes: attributes('task'),
    };
  }

  /** Visible in detail endpoints: members always, everyone for public projects. */
  function readableProject(project: FakeProject, userId: number): boolean {
    return project.members.includes(userId) || !project.is_private;
  }

  /** Project for an admin-only write, or 404 (invisible) / 403 (not admin), like taiga-back. */
  function adminProject(id: unknown, userId: number): FakeProject {
    const project = state.projects.find((p) => p.id === id);
    if (!project || !readableProject(project, userId)) throw notFound();
    if (!project.members.includes(userId) || !project.admins.includes(userId)) throw permissionDenied();
    return project;
  }

  function membershipJson(membership: FakeMembership): Json {
    const member = state.users.find((u) => u.id === membership.user);
    const role = state.roles.find((r) => r.id === membership.role)!;
    const project = state.projects.find((p) => p.id === membership.project)!;
    return {
      id: membership.id,
      project: membership.project,
      project_slug: project.slug,
      role: role.id,
      role_name: role.name,
      user: membership.user,
      email: membership.email,
      user_email: member?.email ?? null,
      full_name: member?.username ?? null,
      is_admin: membership.user !== null && project.admins.includes(membership.user),
    };
  }

  function createProject(body: unknown, userId: number): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, PROJECT_FIELDS, errors);
    if (typeof data.name !== 'string' || data.name.trim() === '') errors.name = ['This field is required.'];
    if (typeof data.description !== 'string' || data.description.trim() === '') errors.description = ['This field is required.'];
    const template = data.creation_template === undefined ? state.templates.find((t) => t.slug === 'scrum') : state.templates.find((t) => t.id === data.creation_template);
    if (!template) errors.creation_template = [`Invalid pk "${String(data.creation_template)}" - object does not exist.`];
    for (const flag of [...MODULE_FLAGS, 'is_private']) {
      if (data[flag] !== undefined && typeof data[flag] !== 'boolean') errors[flag] = ['Must be a valid boolean.'];
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const owner = state.users.find((u) => u.id === userId)!;
    const base = taigaSlugify(settings.projectSlugPrefix ? `${owner.username}-${data.name as string}` : (data.name as string)) || 'null';
    let slug = base;
    for (let suffix = 1; state.projects.some((p) => p.slug === slug); suffix += 1) slug = `${base}-${suffix}`;
    const modules = { ...template!.modules };
    for (const flag of MODULE_FLAGS) if (typeof data[flag] === 'boolean') modules[flag] = data[flag] as boolean;
    const project: FakeProject = {
      id: ++nextId,
      slug,
      name: data.name as string,
      members: [],
      lastRef: 0,
      description: data.description as string,
      is_private: (data.is_private as boolean | undefined) ?? true,
      creation_template: template!.id,
      admins: [userId],
      modules,
      tagsColors: {},
    };
    state.projects.push(project);
    addRoles(project, template!.roles);
    addMembership({ project: project.id, role: template!.roles[0]!.slug, user: userId });
    return { status: 201, body: projectJson(project, userId) };
  }

  function patchProject(project: FakeProject, body: unknown, userId: number): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, PROJECT_FIELDS, errors);
    delete errors.creation_template;
    if (data.creation_template !== undefined) errors.creation_template = ['Only used when creating a project.'];
    for (const flag of [...MODULE_FLAGS, 'is_private']) {
      if (data[flag] !== undefined && typeof data[flag] !== 'boolean') errors[flag] = ['Must be a valid boolean.'];
    }
    if (data.name !== undefined && (typeof data.name !== 'string' || data.name.trim() === '')) errors.name = ['This field is required.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    for (const flag of MODULE_FLAGS) if (typeof data[flag] === 'boolean') project.modules[flag] = data[flag] as boolean;
    if (typeof data.is_private === 'boolean') project.is_private = data.is_private;
    if (typeof data.name === 'string') project.name = data.name;
    if (typeof data.description === 'string') project.description = data.description;
    return { status: 200, body: projectJson(project, userId) };
  }

  function tagOperation(project: FakeProject, action: 'create_tag' | 'edit_tag', body: unknown): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    const existing = projectTagsColors(project);
    if (action === 'create_tag') {
      unknownFields(data, { tag: true, color: true }, errors);
      if (typeof data.tag !== 'string' || data.tag === '') errors.tag = ['This field is required.'];
      else if (Object.hasOwn(existing, data.tag)) errors.tag = ['This tag already exists.'];
    } else {
      unknownFields(data, { from_tag: true, to_tag: true, color: true }, errors);
      if (typeof data.from_tag !== 'string' || data.from_tag === '') errors.from_tag = ['This field is required.'];
      else if (!Object.hasOwn(existing, data.from_tag)) errors.from_tag = ["The tag doesn't exist."];
      if (data.to_tag !== undefined && data.to_tag !== data.from_tag) errors.to_tag = ['Renaming tags is not supported by the fake.'];
    }
    if (data.color !== undefined && data.color !== null && (typeof data.color !== 'string' || (data.color !== '' && !HEX_COLOR.test(data.color)))) {
      errors.color = ['The color is not a valid HEX color.'];
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const tag = (action === 'create_tag' ? data.tag : data.from_tag) as string;
    project.tagsColors[tag] = typeof data.color === 'string' && data.color !== '' ? data.color : action === 'edit_tag' ? (existing[tag] ?? null) : null;
    return { status: 200 };
  }

  function createCustomAttribute(itemType: FakeCustomAttributeType, body: unknown, userId: number): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, CUSTOM_ATTRIBUTE_FIELDS, errors);
    if (data.project === undefined) errors.project = ['This field is required.'];
    if (typeof data.name !== 'string' || data.name.trim() === '') errors.name = ['This field is required.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    if (data.order !== undefined && !Number.isInteger(data.order)) errors.order = ['Enter a whole number.'];
    if (data.type !== undefined && !CUSTOM_ATTRIBUTE_TYPES.includes(data.type as string)) errors.type = [`Select a valid choice. ${String(data.type)} is not one of the available choices.`];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const project = adminProject(data.project, userId);
    if (state.customAttributes.some((a) => a.project === project.id && a.itemType === itemType && a.name === data.name)) {
      throw fieldErrors({ __all__: ['Custom attribute with this Name and Project already exists.'] });
    }
    const attribute = addCustomAttribute({ itemType, project: project.id, name: data.name as string, description: data.description as string | undefined, type: data.type as string | undefined });
    return { status: 201, body: customAttributeJson(attribute) };
  }

  function createMembership(body: unknown, userId: number): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, { project: true, role: true, username: true }, errors);
    if (data.project === undefined) errors.project = ['This field is required.'];
    if (data.role === undefined) errors.role = ['This field is required.'];
    if (typeof data.username !== 'string' || data.username === '') errors.username = ['This field is required.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const project = adminProject(data.project, userId);
    const role = state.roles.find((r) => r.id === data.role && r.project === project.id);
    if (!role) throw fieldErrors({ role: [`Invalid pk "${String(data.role)}" - object does not exist.`] });
    const name = (data.username as string).toLowerCase();
    const invited = state.users.find((u) => u.username.toLowerCase() === name || u.email?.toLowerCase() === name);
    if (!invited && !name.includes('@')) throw fieldErrors({ username: ['The user must be a valid contact'] });
    const duplicate = state.memberships.some(
      (m) => m.project === project.id && (invited ? m.user === invited.id : m.email?.toLowerCase() === name),
    );
    if (duplicate) throw fieldErrors({ username: ['The user is already member of the project'] });
    const membership = addMembership({ project: project.id, role: role.slug, user: invited?.id, email: invited ? undefined : (data.username as string) });
    if (invited) membership.email = data.username as string;
    return { status: 201, body: membershipJson(membership) };
  }

  function createWikiPage(body: unknown, userId: number): Reply {
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, { project: true, slug: true, content: true, watchers: true }, errors);
    if (data.project === undefined) errors.project = ['This field is required.'];
    if (typeof data.slug !== 'string' || data.slug === '') errors.slug = ['This field is required.'];
    if (typeof data.content !== 'string') errors.content = ['This field is required.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const project = visibleProject(data.project, userId);
    if (!project) throw fieldErrors({ project: [`Invalid pk "${String(data.project)}" - object does not exist.`] });
    if (state.wikiPages.some((p) => p.project === project.id && p.slug === data.slug)) {
      throw fieldErrors({ __all__: ['Wiki page with this Project and Slug already exists.'] });
    }
    return { status: 201, body: { ...addWikiPage({ project: project.id, slug: data.slug as string, content: data.content as string }) } };
  }

  /** Routes used by `taigent bootstrap` (project, tags, custom attributes, memberships, wiki). */
  function bootstrapRoute(method: string, path: string, query: URLSearchParams, body: unknown, userId: number): Reply | undefined {
    if (method === 'GET' && path === '/users/me') {
      const me = state.users.find((u) => u.id === userId)!;
      return { status: 200, body: { id: me.id, username: me.username, email: me.email ?? null, full_name: me.username } };
    }
    if (method === 'POST' && path === '/projects') return createProject(body, userId);

    const projectPath = /^\/projects\/(\d+)(?:\/(create_tag|edit_tag))?$/.exec(path);
    if (projectPath) {
      const id = Number(projectPath[1]);
      const action = projectPath[2] as 'create_tag' | 'edit_tag' | undefined;
      if (!action && method === 'GET') {
        const project = state.projects.find((p) => p.id === id && readableProject(p, userId));
        if (!project) throw notFound();
        return { status: 200, body: projectJson(project, userId) };
      }
      if (!action && method === 'PATCH') return patchProject(adminProject(id, userId), body, userId);
      if (action && method === 'POST') return tagOperation(adminProject(id, userId), action, body);
    }

    const attributes = /^\/(epic|userstory|task)-custom-attributes$/.exec(path);
    if (attributes) {
      const itemType = attributes[1] as FakeCustomAttributeType;
      if (method === 'POST') return createCustomAttribute(itemType, body, userId);
      if (method === 'GET') {
        const projectId = Number(query.get('project'));
        const list = state.customAttributes.filter((a) => a.itemType === itemType && a.project === projectId && visibleProject(a.project, userId));
        return { status: 200, body: list.map(customAttributeJson) };
      }
    }

    if (path === '/memberships') {
      if (method === 'POST') return createMembership(body, userId);
      if (method === 'GET') {
        const projectId = Number(query.get('project'));
        const list = state.memberships.filter((m) => m.project === projectId && visibleProject(m.project, userId));
        return { status: 200, body: list.map(membershipJson) };
      }
    }

    if (method === 'GET' && path === '/wiki/by_slug') {
      const page = state.wikiPages.find(
        (p) => p.slug === query.get('slug') && p.project === Number(query.get('project')) && visibleProject(p.project, userId),
      );
      if (!page) throw notFound();
      return { status: 200, body: { ...page } };
    }
    if (method === 'POST' && path === '/wiki') return createWikiPage(body, userId);
    return undefined;
  }

  function visibleProject(id: unknown, userId: number): FakeProject | undefined {
    return state.projects.find((p) => p.id === id && p.members.includes(userId));
  }

  function paginate(req: IncomingMessage, query: URLSearchParams, items: unknown[]): Reply {
    if (req.headers['x-disable-pagination'] !== undefined) return { status: 200, body: items };
    const page = Number(query.get('page') ?? '1');
    const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    if (!Number.isInteger(page) || page < 1 || page > pages) throw notFound();
    const headers: Record<string, string> = {
      'x-paginated': 'true',
      'x-paginated-by': String(PAGE_SIZE),
      'x-pagination-count': String(items.length),
      'x-pagination-current': String(page),
    };
    if (page < pages) headers['x-pagination-next'] = `?page=${page + 1}`;
    return { status: 200, body: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), headers };
  }

  function validateTags(value: unknown): string[] {
    if (!Array.isArray(value)) throw fieldErrors({ tags: ['Expected a list of items.'] });
    return value.map((tag) => {
      if (typeof tag === 'string') return tag;
      if (Array.isArray(tag) && tag.length === 2 && typeof tag[0] === 'string') {
        const color = tag[1];
        if (color === null || color === '' || (typeof color === 'string' && /^#([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(color))) {
          return tag[0];
        }
      }
      throw fieldErrors({ tags: [`Invalid tag '${JSON.stringify(tag)}'. it must be the name or a pair '["name", "hex color/" | null]'.`] });
    });
  }

  function createEpic(body: unknown, userId: number): Reply {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fieldErrors({ non_field_errors: ['Invalid data'] });
    }
    const data = body as Json;
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(data)) {
      if (!Object.hasOwn(EPIC_FIELDS, field)) errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
    }
    if (data.project === undefined) errors.project = ['This field is required.'];
    else if (!Number.isInteger(data.project) || !visibleProject(data.project, userId)) {
      errors.project = [`Invalid pk "${String(data.project)}" - object does not exist.`];
    }
    if (data.subject === undefined) errors.subject = ['This field is required.'];
    else if (typeof data.subject !== 'string' || data.subject.trim() === '') errors.subject = ['This field is required.'];
    else if (data.subject.length > 500) errors.subject = ['Ensure this value has at most 500 characters.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    let tags: string[] = [];
    if (data.tags !== undefined) {
      try {
        tags = validateTags(data.tags);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        Object.assign(errors, error.reply.body);
      }
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const epic = addEpic({
      project: data.project as number,
      subject: data.subject as string,
      description: (data.description as string | undefined) ?? '',
      tags,
    });
    return { status: 201, body: epicJson(epic) };
  }

  function authenticate(req: IncomingMessage): number {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const userId = match ? tokens.get(match[1]!) : undefined;
    if (userId === undefined) {
      throw new HttpError(401, { _error_message: 'Invalid token', _error_type: 'taiga.base.exceptions.NotAuthenticated' });
    }
    return userId;
  }

  function route(req: IncomingMessage, path: string, query: URLSearchParams, body: unknown): Reply {
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/auth') {
      const data = (body ?? {}) as Json;
      if (data.type !== 'normal') throw fieldErrors({ type: ['Invalid auth type'] });
      const found = state.users.find((u) => u.username === data.username && u.password === data.password);
      if (!found) {
        throw new HttpError(401, {
          _error_message: 'No active account found with the given credentials',
          _error_type: 'taiga.base.exceptions.NotAuthenticated',
        });
      }
      const token = `token-${found.id}-${tokens.size + 1}`;
      tokens.set(token, found.id);
      return { status: 200, body: { id: found.id, username: found.username, auth_token: token, refresh: `refresh-${token}` } };
    }

    if (method === 'GET' && path === '/project-templates') {
      // AllowAny in taiga-back: no token needed.
      const templates = state.templates.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        ...t.modules,
        default_owner_role: t.roles[0]!.slug,
        roles: t.roles.map((r, index) => ({ name: r.name, slug: r.slug, order: (index + 1) * 10, computable: true, permissions: [] })),
      }));
      return { status: 200, body: templates };
    }

    const userId = authenticate(req);

    if (method === 'GET' && path === '/projects/by_slug') {
      const project = state.projects.find((p) => p.slug === query.get('slug') && readableProject(p, userId));
      if (!project) throw notFound();
      return { status: 200, body: projectJson(project, userId) };
    }

    const bootstrapReply = bootstrapRoute(method, path, query, body, userId);
    if (bootstrapReply) return bootstrapReply;

    if (path === '/epics') {
      if (method === 'GET') {
        const projectId = query.has('project') ? Number(query.get('project')) : undefined;
        const epics = state.epics
          .filter((e) => visibleProject(e.project, userId) && (projectId === undefined || e.project === projectId))
          .map(epicJson);
        return paginate(req, query, epics);
      }
      if (method === 'POST') return createEpic(body, userId);
    }

    throw notFound();
  }

  function takeIntercept(method: string, path: string): InterceptRule | undefined {
    const index = intercepts.findIndex(
      (r) => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    );
    if (index === -1) return undefined;
    const rule = intercepts[index]!;
    if ((rule.after ?? 0) > 0) {
      rule.after! -= 1;
      return undefined;
    }
    rule.times = (rule.times ?? 1) - 1;
    if (rule.times <= 0) intercepts.splice(index, 1);
    return rule;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let reply: Reply;
    let body: unknown;
    try {
      body = raw === '' ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const path = url.pathname.startsWith('/api/v1/') ? url.pathname.slice('/api/v1'.length) : undefined;
    const method = req.method ?? 'GET';
    requests.push({ method, path: path ?? url.pathname, query: url.searchParams, headers: req.headers, body });
    try {
      if (path === undefined) throw notFound();
      if (typeof body === 'string') throw new HttpError(400, { _error_message: 'JSON parse error' });
      const rule = takeIntercept(method, path);
      reply = rule ? { status: rule.status, body: rule.body, headers: rule.headers } : route(req, path, url.searchParams, body);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      reply = error.reply;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ _error_message: `fake taiga crashed: ${String(error)}` }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    state,
    requests,
    user,
    addProject,
    addEpic,
    settings,
    addUser,
    addCustomAttribute,
    addMembership,
    addWikiPage,
    intercept: (rule) => void intercepts.push({ ...rule }),
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

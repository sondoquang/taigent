// In-process fake of the Taiga REST API (https://docs.taiga.io/api.html).
// It is the single test seam for talking to Taiga: tests point TAIGA_API_URL at
// `fake.url` and assert on `fake.state` afterwards. Extend it (endpoints, hooks)
// instead of mocking internal modules.
//
// Fidelity rules (mirroring taiga-back):
// - Every route lives under /api/v1; everything except POST /auth and POST /auth/refresh needs
//   `Authorization: Bearer <token>`. Access tokens can be expired on demand (`expireTokens`); refresh
//   tokens rotate on every `/auth/refresh`, like taiga-back's SIMPLE_JWT settings.
// - Lists are paginated (30 per page, `x-pagination-*` headers) unless `x-disable-pagination` is sent.
// - Tags are stored lowercased and returned as `[name, color|null]` pairs. The epic, user story and task lists
//   filter by `tags=a,b` (items carrying any listed tag, exact match), like taiga-back's TagsFilter.
// - Validation errors are 400 with DRF-style `{ field: [message] }` bodies. The fake is STRICTER than
//   Taiga on one point: unknown payload fields are rejected (Taiga silently ignores them), so typos
//   such as `project_id` instead of `project` fail loudly in tests.
// - PATCH implements OCC like taiga-back: `version` is required, and a stale version is refused with
//   400 {"version": "..."} only when a field in the payload was modified since that version.
// - Epic ↔ story links are unique per (epic, user_story); a duplicate POST is a 400.
// - Every epic, user story and task gets a custom attribute values object (version 1, no values) when it is
//   created, like taiga-back's post_save signal. Its `attributes_values` keys are attribute ids as strings, a
//   PATCH replaces the whole object, and it has its own OCC `version`.

import { createHash } from 'node:crypto';
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

/** Custom attribute values of one item, `/{epics,userstories,tasks}/custom-attributes-values/{item}` (api.html#user-story-custom-attributes-values-get). */
export interface FakeCustomAttributeValues {
  itemType: FakeCustomAttributeType;
  /** Id of the epic, user story or task. */
  item: number;
  version: number;
  /** Attribute id (string) → value. */
  attributes_values: Record<string, unknown>;
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

/** Points estimate: role id → points id ("dictionary of points" in the Taiga API docs). */
export type FakePoints = Record<string, number>;

export interface FakeUserStory {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
  /** Taiga 6 assigns a story to several users; `GET /userstories?assigned_users=<id>` filters on them. */
  assigned_users: number[];
  milestone: number | null;
  points: FakePoints;
  is_closed: boolean;
  /** When the story was closed (ISO 8601), null while open. */
  finish_date: string | null;
}

export interface FakeTask {
  id: number;
  ref: number;
  version: number;
  project: number;
  user_story: number | null;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
  milestone: number | null;
  is_closed: boolean;
  /** When the task was closed (ISO 8601), null while open. */
  finished_date: string | null;
}

/** An issue (docs.taiga.io/api.html §28). Not a backlog item: only `GET /issues` exists in the fake. */
export interface FakeIssue {
  id: number;
  ref: number;
  version: number;
  project: number;
  subject: string;
  description: string;
  tags: string[];
  status: number | null;
  assigned_to: number | null;
  is_closed: boolean;
  finished_date: string | null;
}

/** Epic ↔ user story link ("epic related user story detail" in the Taiga API docs). */
export interface FakeEpicRelatedUserStory {
  epic: number;
  user_story: number;
  order: number;
}

export type FakeItem = FakeEpic | FakeUserStory | FakeTask;

/** URL segment of the attachment endpoints (`/{type}/attachments`), one per content type. */
export type FakeAttachmentObjectType = 'epics' | 'userstories' | 'tasks' | 'wiki';

/** An attachment ("attachment detail" in the Taiga API docs) plus its stored bytes. */
export interface FakeAttachment {
  id: number;
  project: number;
  objectType: FakeAttachmentObjectType;
  object_id: number;
  /** Base name of the uploaded file name, like taiga-back's pre_save. */
  name: string;
  size: number;
  /** Hex sha1 of the bytes, like taiga-back's Attachment._generate_sha1. */
  sha1: string;
  description: string;
  is_deprecated: boolean;
  from_comment: boolean;
  content: Buffer;
}

/** A file part of a multipart request. */
export interface FakeUploadedFile {
  filename: string;
  content: Buffer;
}

/** Parsed `multipart/form-data` request body (the recorded `body` of such requests). */
export class MultipartForm {
  readonly fields: Record<string, string>;
  readonly files: Record<string, FakeUploadedFile>;

  constructor(fields: Record<string, string>, files: Record<string, FakeUploadedFile>) {
    this.fields = fields;
    this.files = files;
  }
}

export interface FakeState {
  users: FakeUser[];
  projects: FakeProject[];
  epics: FakeEpic[];
  userStories: FakeUserStory[];
  tasks: FakeTask[];
  issues: FakeIssue[];
  epicRelatedUserStories: FakeEpicRelatedUserStory[];
  templates: FakeTemplate[];
  roles: FakeRole[];
  customAttributes: FakeCustomAttribute[];
  customAttributeValues: FakeCustomAttributeValues[];
  memberships: FakeMembership[];
  wikiPages: FakeWikiPage[];
  attachments: FakeAttachment[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
  /** `performance.now()` when the request arrived (for asserting backoff delays). */
  at: number;
}

export interface InterceptRule {
  method: string;
  /** Path below /api/v1, e.g. `/epics` or a RegExp matched against it. */
  path: string | RegExp;
  status: number;
  body?: unknown;
  /** Builds the body from the intercepted request instead (e.g. a server echoing what it received). */
  bodyFrom?: (request: RecordedRequest) => unknown;
  headers?: Record<string, string>;
  /** How many matching requests to let through untouched before intercepting (default 0). */
  after?: number;
  /** How many matching requests to intercept (default 1). */
  times?: number;
}

export interface RequestHook {
  method: string;
  /** Path below /api/v1, or a RegExp matched against it. */
  path: string | RegExp;
  /** Runs right before the fake handles the matching request, e.g. to simulate a concurrent edit. */
  run: () => void;
  /** How many matching requests trigger the hook (default 1). */
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
  /**
   * Instance settings. `projectSlugPrefix` mirrors taiga-back's DEFAULT_PROJECT_SLUG_PREFIX (slug = owner-name).
   * `maxBodyBytes` mimics the reverse proxy's limit (nginx `client_max_body_size`): a larger request body
   * gets nginx's HTML 413 page before reaching Taiga.
   */
  settings: { projectSlugPrefix: boolean; maxBodyBytes?: number };
  /** Seeds an attachment as if uploaded through `POST /{objectType}/attachments`. */
  addAttachment(input: { project: number; objectType: FakeAttachmentObjectType; object_id: number; name: string; content: Buffer | string; description?: string }): FakeAttachment;
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
  addEpic(input: FakeItemInput): FakeEpic;
  addUser(input: { username: string; email?: string }): FakeUser;
  addCustomAttribute(input: { itemType: FakeCustomAttributeType; project: number; name: string; description?: string; type?: string }): FakeCustomAttribute;
  /** Sets an item's custom attribute values like a Taiga user would (replaces them, bumps `version`). */
  editAttributeValues(itemType: FakeCustomAttributeType, item: number, values: Record<string, unknown>): void;
  /** Adds a membership; an existing user (by id) also becomes a project member. */
  addMembership(input: { project: number; role: string; user?: number; email?: string }): FakeMembership;
  addWikiPage(input: { project: number; slug: string; content: string }): FakeWikiPage;
  /** Edits a wiki page like a Taiga user would: bumps `version`, recorded for OCC checks. */
  editWikiPage(page: FakeWikiPage, changes: Partial<Pick<FakeWikiPage, 'content' | 'slug'>>): void;
  /** Answer the next matching request(s) with a canned response instead of handling it. */
  intercept(rule: InterceptRule): void;
  addUserStory(input: FakeItemInput): FakeUserStory;
  addTask(input: FakeItemInput & { user_story?: number }): FakeTask;
  addIssue(input: FakeItemInput): FakeIssue;
  addEpicRelatedUserStory(epic: number, userStory: number): FakeEpicRelatedUserStory;
  /** Edits an item like a Taiga user would: bumps `version` and records the fields for OCC checks. */
  editItem<T extends FakeItem>(item: T, changes: Partial<Omit<T, 'id' | 'ref' | 'version' | 'project'>>): void;
  /** Run a callback before the next matching request(s) are handled. */
  onRequest(hook: RequestHook): void;
  close(): Promise<void>;
  /** Every access and refresh token issued so far, in order (for asserting they never leak). */
  issuedTokens: string[];
  /** Issues an access token for the default user without POST /auth (e.g. for TAIGA_TOKEN). */
  issueToken(): string;
  /**
   * Expires every access token issued so far, like Taiga's 24h access-token lifetime running out,
   * once `after` more authenticated requests have been served (default 0: before the next one).
   * With `refresh: true` the refresh tokens are revoked too, forcing a new login.
   */
  expireTokens(options?: { after?: number; refresh?: boolean }): void;
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

// Create/edit payload fields documented for user stories and tasks (docs.taiga.io/api.html §18.2, §23.2).
const USER_STORY_FIELDS: Record<string, true> = {
  assigned_to: true, backlog_order: true, blocked_note: true, client_requirement: true, description: true,
  is_blocked: true, is_closed: true, kanban_order: true, milestone: true, points: true, project: true,
  sprint_order: true, status: true, subject: true, tags: true, team_requirement: true, watchers: true,
};

const TASK_FIELDS: Record<string, true> = {
  assigned_to: true, blocked_note: true, description: true, is_blocked: true, is_closed: true, milestone: true,
  project: true, user_story: true, status: true, subject: true, tags: true, us_order: true, taskboard_order: true,
  is_iocaine: true, external_reference: true, watchers: true,
};

const RELATED_USER_STORY_FIELDS: Record<string, true> = { epic: true, user_story: true, order: true };

/** URL segment of the epic, user story and task endpoints (`/{segment}`, `/{segment}/{id}`, …). */
type ItemSegment = 'epics' | 'userstories' | 'tasks';

/**
 * Per URL segment: the item type (custom attributes, values objects), the item key of its values object and the
 * create/edit payload fields.
 */
const ITEM_KINDS: Record<ItemSegment, { itemType: FakeCustomAttributeType; valuesField: string; fields: Record<string, true> }> = {
  epics: { itemType: 'epic', valuesField: 'epic', fields: EPIC_FIELDS },
  userstories: { itemType: 'userstory', valuesField: 'user_story', fields: USER_STORY_FIELDS },
  tasks: { itemType: 'task', valuesField: 'task', fields: TASK_FIELDS },
};

/** Fixture input shared by `addEpic`, `addUserStory` and `addTask`. */
export interface FakeItemInput {
  project: number;
  subject: string;
  description?: string;
  tags?: string[];
}

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

/** Writable fields of taiga-back's AttachmentValidator (multipart form fields and files). */
const ATTACHMENT_FIELDS: Record<string, true> = {
  object_id: true,
  project: true,
  attached_file: true,
  description: true,
  is_deprecated: true,
  from_comment: true,
  order: true,
};

/** nginx's default 413 page (Taiga's reverse proxy answers before the request reaches taiga-back). */
const NGINX_413 =
  '<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n' +
  '<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

/** Parses a `multipart/form-data` body with the platform's own parser (undici's `Response#formData`). */
async function parseMultipart(bytes: Buffer, contentType: string): Promise<MultipartForm | string> {
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return 'malformed multipart body';
  }
  const fields: Record<string, string> = {};
  const files: Record<string, FakeUploadedFile> = {};
  for (const [name, value] of form) {
    if (typeof value === 'string') fields[name] = value;
    else files[name] = { filename: value.name, content: Buffer.from(await value.arrayBuffer()) };
  }
  return new MultipartForm(fields, files);
}

export async function startFakeTaiga(): Promise<FakeTaiga> {
  const user: FakeUser = { id: 1, username: 'taigent-bot', password: 'fake-password-123', email: 'taigent-bot@example.test' };
  const state: FakeState = {
    users: [user],
    projects: [],
    epics: [],
    userStories: [],
    tasks: [],
    issues: [],
    epicRelatedUserStories: [],
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
    customAttributeValues: [],
    memberships: [],
    wikiPages: [],
    attachments: [],
  };
  const settings: FakeTaiga['settings'] = { projectSlugPrefix: false };
  const requests: RecordedRequest[] = [];
  const intercepts: InterceptRule[] = [];
  const hooks: RequestHook[] = [];
  const tokens = new Map<string, number>();
  let nextId = 1000;
  // Auth: access and refresh tokens map to a user id. Expiry is scheduled by expireTokens().
  const refreshTokens = new Map<string, number>();
  const issuedTokens: string[] = [];
  let tokenSeq = 0;
  let pendingExpiry: { after: number; refresh: boolean } | undefined;

  function issueTokens(userId: number): { auth_token: string; refresh: string } {
    const seq = ++tokenSeq;
    const pair = { auth_token: `token-${userId}-${seq}`, refresh: `refresh-${userId}-${seq}` };
    tokens.set(pair.auth_token, userId);
    refreshTokens.set(pair.refresh, userId);
    issuedTokens.push(pair.auth_token, pair.refresh);
    return pair;
  }

  function applyPendingExpiry(): void {
    if (!pendingExpiry) return;
    if (pendingExpiry.after > 0) {
      pendingExpiry.after -= 1;
      return;
    }
    tokens.clear();
    if (pendingExpiry.refresh) refreshTokens.clear();
    pendingExpiry = undefined;
  }

  // POST /auth/refresh (https://docs.taiga.io/api.html#auth-refresh): { refresh } → new token pair.
  function refreshAuth(body: unknown): Reply {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fieldErrors({ non_field_errors: ['Invalid data'] });
    }
    const data = body as Json;
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(data)) {
      if (field !== 'refresh') errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
    }
    if (typeof data.refresh !== 'string' || data.refresh === '') errors.refresh = ['This field is required.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const userId = refreshTokens.get(data.refresh as string);
    if (userId === undefined) throw new HttpError(401, { detail: 'Token is invalid or expired', code: 'token_not_valid' });
    refreshTokens.delete(data.refresh as string);
    return { status: 200, body: issueTokens(userId) };
  }

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

  /** The collection holding the epics, user stories or tasks. */
  function itemsOf(itemType: FakeCustomAttributeType): FakeItem[] {
    return { epic: state.epics, userstory: state.userStories, task: state.tasks }[itemType];
  }

  /** Creates an epic, user story or task with the next project ref and its (empty) custom attribute values. */
  function addItem<T extends FakeItem>(itemType: FakeCustomAttributeType, input: FakeItemInput, extra: Omit<T, keyof FakeEpic>): T {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const item = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
      ...extra,
    } as T;
    itemsOf(itemType).push(item);
    createAttributeValues(itemType, item.id);
    return item;
  }

  function addEpic(input: FakeItemInput): FakeEpic {
    return addItem<FakeEpic>('epic', input, {});
  }

  function addUserStory(input: FakeItemInput): FakeUserStory {
    return addItem<FakeUserStory>('userstory', input, { assigned_users: [], milestone: null, points: {}, is_closed: false, finish_date: null });
  }

  function addTask(input: FakeItemInput & { user_story?: number }): FakeTask {
    return addItem<FakeTask>('task', input, { user_story: input.user_story ?? null, milestone: null, is_closed: false, finished_date: null });
  }

  /** Issues share the project's ref sequence with epics, stories and tasks, like Taiga's. */
  function addIssue(input: FakeItemInput): FakeIssue {
    const project = state.projects.find((p) => p.id === input.project);
    if (!project) throw new Error(`fake taiga: no project ${input.project}`);
    const issue: FakeIssue = {
      id: ++nextId,
      ref: ++project.lastRef,
      version: 1,
      project: project.id,
      subject: input.subject,
      description: input.description ?? '',
      tags: (input.tags ?? []).map((t) => t.toLowerCase()),
      status: null,
      assigned_to: null,
      is_closed: false,
      finished_date: null,
    };
    state.issues.push(issue);
    return issue;
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
    const wikiPage = /^\/wiki\/(\d+)$/.exec(path);
    if (wikiPage && method === 'PATCH') return patchWikiPage(Number(wikiPage[1]), body, userId);
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
    const { data, tags } = validateItemPayload(body, EPIC_FIELDS, userId);
    const epic = addEpic({
      project: data.project as number,
      subject: data.subject as string,
      description: (data.description as string | undefined) ?? '',
      tags: tags ?? [],
    });
    return { status: 201, body: itemJson(epic) };
  }

  // --- User stories, tasks, epic ↔ story links, PATCH with OCC (ticket #4) ---

  /** Fields changed by each edit, per item: entry i = fields modified going from version i+1 to i+2. */
  const editHistory = new WeakMap<FakeItem | FakeWikiPage, string[][]>();

  /** Values saves per values object: entry i = whether going from version i+1 to i+2 changed `attributes_values`. */
  const valuesHistory = new WeakMap<FakeCustomAttributeValues, boolean[]>();

  /** taiga-back creates the (empty) values object of every new epic, user story and task in a post_save signal. */
  function createAttributeValues(itemType: FakeCustomAttributeType, item: number): void {
    state.customAttributeValues.push({ itemType, item, version: 1, attributes_values: {} });
  }

  function saveAttributeValues(values: FakeCustomAttributeValues, next: Record<string, unknown>): void {
    valuesHistory.set(values, [...(valuesHistory.get(values) ?? []), JSON.stringify(values.attributes_values) !== JSON.stringify(next)]);
    values.attributes_values = next;
    values.version += 1;
  }

  function editAttributeValues(itemType: FakeCustomAttributeType, item: number, next: Record<string, unknown>): void {
    const values = state.customAttributeValues.find((v) => v.itemType === itemType && v.item === item);
    if (!values) throw new Error(`fake taiga: no ${itemType} ${item}`);
    saveAttributeValues(values, next);
  }

  /** GET/PATCH `/{epics,userstories,tasks}/custom-attributes-values/{id}`; the item key is `epic`, `user_story` or `task`. */
  function routeAttributeValues(method: string, path: string, body: unknown, userId: number): Reply | undefined {
    const match = /^\/(epics|userstories|tasks)\/custom-attributes-values\/(\d+)$/.exec(path);
    if (!match) return undefined;
    const { itemType, valuesField: itemField } = ITEM_KINDS[match[1] as ItemSegment];
    const item = itemsOf(itemType).find((i) => i.id === Number(match[2]) && visibleProject(i.project, userId));
    const values = item && state.customAttributeValues.find((v) => v.itemType === itemType && v.item === item.id);
    if (!item || !values) throw notFound();
    const json = () => ({ attributes_values: values.attributes_values, version: values.version, [itemField]: item.id });
    if (method === 'GET') return { status: 200, body: json() };
    if (method !== 'PATCH') return undefined;

    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, { attributes_values: true, version: true, [itemField]: true }, errors);
    const next = data.attributes_values;
    if (next !== undefined) {
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        errors.attributes_values = ['Invalid content. It must be {"key": "value",...}'];
      } else {
        // Keys must be ids of this item type's custom attributes in the item's project.
        const ids = state.customAttributes.filter((a) => a.project === item.project && a.itemType === itemType).map((a) => String(a.id));
        if (Object.keys(next).some((key) => !ids.includes(key))) errors.attributes_values = ['It contain invalid custom fields.'];
      }
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);

    // OCC like the items: `version` required; a stale one fails only if the values changed since then.
    const version = data.version ?? null;
    if (version !== null && !Number.isInteger(version)) throw new HttpError(400, { version: 'The version must be an integer' });
    if (version === null || (version as number) < 0 || (version as number) > values.version) {
      throw new HttpError(400, { version: 'The version parameter is not valid' });
    }
    const history = valuesHistory.get(values) ?? [];
    const changedSince = history.slice(Math.max(0, history.length - (values.version - (version as number)))).some(Boolean);
    if (changedSince && next !== undefined) throw new HttpError(400, { version: "The version doesn't match with the current one" });
    saveAttributeValues(values, (next as Record<string, unknown> | undefined) ?? values.attributes_values);
    return { status: 200, body: json() };
  }

  function addEpicRelatedUserStory(epic: number, userStory: number): FakeEpicRelatedUserStory {
    const order = state.epicRelatedUserStories.filter((link) => link.epic === epic).length + 1;
    const link: FakeEpicRelatedUserStory = { epic, user_story: userStory, order };
    state.epicRelatedUserStories.push(link);
    return link;
  }

  /** Applies changes, records the fields that really changed and bumps the version, like a Taiga save. */
  function saveEdit(item: FakeItem | FakeWikiPage, changes: Json): void {
    const target = item as unknown as Json;
    const modified: string[] = [];
    for (const [field, value] of Object.entries(changes)) {
      const next = field === 'tags' ? (value as string[]).map((t) => t.toLowerCase()) : value;
      if (JSON.stringify(target[field]) !== JSON.stringify(next)) modified.push(field);
      target[field] = next;
    }
    editHistory.set(item, [...(editHistory.get(item) ?? []), modified]);
    item.version += 1;
  }

  function editItem<T extends FakeItem>(item: T, changes: Partial<Omit<T, 'id' | 'ref' | 'version' | 'project'>>): void {
    saveEdit(item, changes as Json);
  }

  function editWikiPage(page: FakeWikiPage, changes: Partial<Pick<FakeWikiPage, 'content' | 'slug'>>): void {
    saveEdit(page, changes as Json);
  }

  /** PATCH /wiki/{id} (docs §32.4): `content`/`slug`/`watchers`, OCC `version` like items. */
  function patchWikiPage(id: number, body: unknown, userId: number): Reply {
    const page = state.wikiPages.find((p) => p.id === id && visibleProject(p.project, userId));
    if (!page) throw notFound();
    const data = requireObject(body);
    const errors: Record<string, string[]> = {};
    unknownFields(data, { content: true, slug: true, watchers: true, version: true }, errors);
    if (data.content !== undefined && typeof data.content !== 'string') errors.content = ['Not a valid string.'];
    if (data.slug !== undefined && (typeof data.slug !== 'string' || data.slug === '')) errors.slug = ['This field is required.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    checkVersion(page, data);
    const { version: _version, watchers: _watchers, ...changes } = data;
    saveEdit(page, changes);
    return { status: 200, body: { ...page } };
  }

  /**
   * Validates a create (POST, no `existing`) or edit (PATCH) payload of an epic, user story or task.
   * Required fields only apply to creation; `version` only to edits.
   */
  function validateItemPayload(body: unknown, allowed: Record<string, true>, userId: number, existing?: FakeItem): { data: Json; tags: string[] | undefined } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw fieldErrors({ non_field_errors: ['Invalid data'] });
    }
    const data = body as Json;
    const errors: Record<string, string[]> = {};
    for (const field of Object.keys(data)) {
      if (!Object.hasOwn(allowed, field) && !(existing && field === 'version')) {
        errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
      }
    }
    if (data.project === undefined) {
      if (!existing) errors.project = ['This field is required.'];
    } else if (!Number.isInteger(data.project) || !visibleProject(data.project, userId)) {
      errors.project = [`Invalid pk "${String(data.project)}" - object does not exist.`];
    }
    if (data.subject === undefined) {
      if (!existing) errors.subject = ['This field is required.'];
    } else if (typeof data.subject !== 'string' || data.subject.trim() === '') errors.subject = ['This field is required.'];
    else if (data.subject.length > 500) errors.subject = ['Ensure this value has at most 500 characters.'];
    if (data.description !== undefined && typeof data.description !== 'string') errors.description = ['Not a valid string.'];
    const points = data.points;
    if (points !== undefined && (typeof points !== 'object' || points === null || Array.isArray(points) || !Object.values(points).every(Number.isInteger))) {
      errors.points = ['Points must be a dictionary of role id → points id (fake wording).'];
    }
    if (data.user_story !== undefined && data.user_story !== null) {
      const projectId = existing?.project ?? data.project;
      if (!state.userStories.some((s) => s.id === data.user_story && s.project === projectId)) {
        errors.user_story = [`Invalid pk "${String(data.user_story)}" - object does not exist.`];
      }
    }
    let tags: string[] | undefined;
    if (data.tags !== undefined) {
      try {
        tags = validateTags(data.tags);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        Object.assign(errors, error.reply.body);
      }
    }
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    return { data, tags };
  }

  /** Taiga OCC (docs §1.2, taiga-back OCCResourceMixin): stale versions only fail when the same fields changed. */
  function checkVersion(item: FakeItem | FakeWikiPage, data: Json): void {
    const raw = data.version;
    if (raw !== undefined && raw !== null && !Number.isInteger(raw)) {
      throw new HttpError(400, { version: 'The version must be an integer' });
    }
    const version = (raw ?? null) as number | null;
    if (version === null || version < 0 || version > item.version) {
      throw new HttpError(400, { version: 'The version parameter is not valid' });
    }
    if (version === item.version) return;
    const history = editHistory.get(item) ?? [];
    const modified = new Set(history.slice(Math.max(0, history.length - (item.version - version))).flat());
    if (Object.keys(data).some((field) => field !== 'version' && modified.has(field))) {
      throw new HttpError(400, { version: "The version doesn't match with the current one" });
    }
  }

  function patchItem(item: FakeItem, body: unknown, allowed: Record<string, true>, userId: number): Json {
    const { data, tags } = validateItemPayload(body, allowed, userId, item);
    checkVersion(item, data);
    const { version: _version, ...changes } = data;
    if (tags !== undefined) changes.tags = tags;
    saveEdit(item, changes);
    return itemJson(item);
  }

  /**
   * An item as taiga-back serializes it: tags as [name, color] pairs, plus the embedded project and status
   * (`project_extra_info`, `status_extra_info`). Status names follow the default templates: a closed story is `Done`,
   * a closed task or issue `Closed`, anything open `New`.
   */
  function itemJson(item: FakeItem | FakeIssue): Json {
    const project = state.projects.find((p) => p.id === item.project)!;
    const closed = 'is_closed' in item && item.is_closed;
    return {
      ...item,
      tags: item.tags.map((t) => [t, null]),
      project_extra_info: { id: project.id, slug: project.slug, name: project.name },
      status_extra_info: { name: closed ? ('finish_date' in item ? 'Done' : 'Closed') : 'New', is_closed: closed },
    };
  }

  /**
   * The assignee and closed filters, by the names each endpoint accepts (checked against a Taiga 6 instance): stories
   * `assigned_users` and `is_closed`, tasks and issues `assigned_to` and `status__is_closed`. Like taiga-back, an
   * endpoint ignores the names it does not know.
   */
  function matchesWork(item: FakeUserStory | FakeTask | FakeIssue, query: URLSearchParams): boolean {
    const story = 'assigned_users' in item;
    const assignee = query.get(story ? 'assigned_users' : 'assigned_to');
    const closed = query.get(story ? 'is_closed' : 'status__is_closed');
    const assigned = story ? item.assigned_users : item.assigned_to === null ? [] : [item.assigned_to];
    return (assignee === null || assigned.includes(Number(assignee))) && (closed === null || String(item.is_closed) === closed.toLowerCase());
  }

  /**
   * taiga-back's TagsFilter (taiga/base/filters.py): `tags=a,b` keeps items carrying ANY listed tag (OR of
   * `tags__contains=[tag]`, exact match: tags are stored lowercased, the query is not lowercased). taiga-back has it in
   * the `filter_backends` of epics, user stories and tasks alike: taiga/projects/{epics,userstories,tasks}/api.py.
   */
  function hasTags(item: FakeItem, query: URLSearchParams): boolean {
    const wanted = query.get('tags');
    if (!wanted) return true;
    return wanted.split(',').some((tag) => item.tags.includes(tag));
  }

  function queryNumber(query: URLSearchParams, name: string): number | undefined {
    return query.has(name) ? Number(query.get(name)) : undefined;
  }

  function routeStoriesAndTasks(req: IncomingMessage, method: string, path: string, query: URLSearchParams, body: unknown, userId: number): Reply | undefined {
    if (path === '/userstories') {
      if (method === 'GET') {
        const projectId = queryNumber(query, 'project');
        const stories = state.userStories.filter(
          (s) => visibleProject(s.project, userId) && (projectId === undefined || s.project === projectId) && hasTags(s, query) && matchesWork(s, query),
        );
        return paginate(req, query, stories.map(itemJson));
      }
      if (method === 'POST') {
        const { data, tags } = validateItemPayload(body, USER_STORY_FIELDS, userId);
        const story = addUserStory({
          project: data.project as number,
          subject: data.subject as string,
          description: (data.description as string | undefined) ?? '',
          tags: tags ?? [],
        });
        for (const field of ['status', 'assigned_to', 'milestone', 'points'] as const) {
          if (data[field] !== undefined) (story as unknown as Json)[field] = data[field];
        }
        return { status: 201, body: itemJson(story) };
      }
    }

    if (path === '/tasks') {
      if (method === 'GET') {
        const projectId = queryNumber(query, 'project');
        const storyId = queryNumber(query, 'user_story');
        const tasks = state.tasks.filter(
          (task) =>
            visibleProject(task.project, userId) &&
            (projectId === undefined || task.project === projectId) &&
            (storyId === undefined || task.user_story === storyId) &&
            hasTags(task, query) &&
            matchesWork(task, query),
        );
        return paginate(req, query, tasks.map(itemJson));
      }
      if (method === 'POST') {
        const { data, tags } = validateItemPayload(body, TASK_FIELDS, userId);
        const task = addTask({
          project: data.project as number,
          user_story: (data.user_story as number | null | undefined) ?? undefined,
          subject: data.subject as string,
          description: (data.description as string | undefined) ?? '',
          tags: tags ?? [],
        });
        for (const field of ['status', 'assigned_to', 'milestone'] as const) {
          if (data[field] !== undefined) (task as unknown as Json)[field] = data[field];
        }
        return { status: 201, body: itemJson(task) };
      }
    }

    if (path === '/issues' && method === 'GET') {
      const projectId = queryNumber(query, 'project');
      const issues = state.issues.filter(
        (issue) => visibleProject(issue.project, userId) && (projectId === undefined || issue.project === projectId) && matchesWork(issue, query),
      );
      return paginate(req, query, issues.map(itemJson));
    }

    const itemPath = /^\/(epics|userstories|tasks)\/(\d+)$/.exec(path);
    if (itemPath && method === 'PATCH') {
      const { itemType, fields } = ITEM_KINDS[itemPath[1] as ItemSegment];
      const item = itemsOf(itemType).find((i) => i.id === Number(itemPath[2]) && visibleProject(i.project, userId));
      if (!item) throw notFound();
      return { status: 200, body: patchItem(item, body, fields, userId) };
    }

    const related = /^\/epics\/(\d+)\/related_userstories$/.exec(path);
    if (related) {
      const epic = state.epics.find((e) => e.id === Number(related[1]) && visibleProject(e.project, userId));
      if (!epic) throw notFound();
      if (method === 'GET') {
        return paginate(req, query, state.epicRelatedUserStories.filter((link) => link.epic === epic.id));
      }
      if (method === 'POST') {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fieldErrors({ non_field_errors: ['Invalid data'] });
        const data = body as Json;
        const errors: Record<string, string[]> = {};
        for (const field of Object.keys(data)) {
          if (!Object.hasOwn(RELATED_USER_STORY_FIELDS, field)) errors[field] = ['Unknown field (the fake Taiga rejects unknown fields).'];
        }
        if (data.epic === undefined) errors.epic = ['This field is required.'];
        else if (data.epic !== epic.id) errors.epic = [`Invalid pk "${String(data.epic)}" - must be the epic of the URL (fake wording).`];
        if (data.user_story === undefined) errors.user_story = ['This field is required.'];
        else if (!state.userStories.some((s) => s.id === data.user_story && visibleProject(s.project, userId))) {
          errors.user_story = [`Invalid pk "${String(data.user_story)}" - object does not exist.`];
        }
        if (Object.keys(errors).length > 0) throw fieldErrors(errors);
        if (state.epicRelatedUserStories.some((link) => link.epic === epic.id && link.user_story === data.user_story)) {
          throw fieldErrors({ non_field_errors: ['The fields user_story, epic must make a unique set.'] });
        }
        return { status: 201, body: addEpicRelatedUserStory(epic.id, data.user_story as number) };
      }
    }

    return undefined;
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
      return { status: 200, body: { id: found.id, username: found.username, ...issueTokens(found.id) } };
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

    if (method === 'POST' && path === '/auth/refresh') return refreshAuth(body);

    applyPendingExpiry();
    const userId = authenticate(req);

    if (method === 'GET' && path === '/projects/by_slug') {
      const project = state.projects.find((p) => p.slug === query.get('slug') && readableProject(p, userId));
      if (!project) throw notFound();
      return { status: 200, body: projectJson(project, userId) };
    }

    // taiga-back ResolverViewSet.list: an unfiltered lookup by slug, then the view_project check, so a private
    // project the user cannot see is a 403 while a free slug is a 404 (references/api.py, permissions.py).
    if (method === 'GET' && path === '/resolver') {
      const project = state.projects.find((p) => p.slug === query.get('project'));
      if (!project) throw notFound();
      if (!readableProject(project, userId)) throw permissionDenied();
      return { status: 200, body: { project: project.id } };
    }

    const bootstrapReply = bootstrapRoute(method, path, query, body, userId);
    if (bootstrapReply) return bootstrapReply;

    if (path === '/epics') {
      if (method === 'GET') {
        const projectId = queryNumber(query, 'project');
        const epics = state.epics
          .filter((e) => visibleProject(e.project, userId) && (projectId === undefined || e.project === projectId) && hasTags(e, query))
          .map(itemJson);
        return paginate(req, query, epics);
      }
      if (method === 'POST') return createEpic(body, userId);
    }

    const attachmentReply = routeAttachments(req, method, path, query, body, userId);
    if (attachmentReply) return attachmentReply;
    const valuesReply = routeAttributeValues(method, path, body, userId);
    if (valuesReply) return valuesReply;
    const reply = routeStoriesAndTasks(req, method, path, query, body, userId);
    if (reply) return reply;
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

  function runHooks(method: string, path: string): void {
    for (const hook of [...hooks]) {
      if (hook.method !== method || !(typeof hook.path === 'string' ? hook.path === path : hook.path.test(path))) continue;
      hook.times = (hook.times ?? 1) - 1;
      if (hook.times <= 0) hooks.splice(hooks.indexOf(hook), 1);
      hook.run();
    }
  }

  // --- Attachments (ticket #9): multipart upload, sha1/size computed from the bytes like taiga-back ---

  function addAttachment(input: Parameters<FakeTaiga['addAttachment']>[0]): FakeAttachment {
    const content = typeof input.content === 'string' ? Buffer.from(input.content) : input.content;
    const attachment: FakeAttachment = {
      id: ++nextId,
      project: input.project,
      objectType: input.objectType,
      object_id: input.object_id,
      name: input.name,
      size: content.length,
      sha1: createHash('sha1').update(content).digest('hex'),
      description: input.description ?? '',
      is_deprecated: false,
      from_comment: false,
      content,
    };
    state.attachments.push(attachment);
    return attachment;
  }

  /** Attachment detail object (docs §64), without the stored bytes. */
  function attachmentJson(attachment: FakeAttachment): Json {
    const { content: _content, objectType: _objectType, ...rest } = attachment;
    const file = `attachments/${attachment.id}/${attachment.name}`;
    return { ...rest, attached_file: file, url: `http://fake/media/${file}`, order: 0, thumbnail_card_url: null };
  }

  /** The epic, user story, task or wiki page an attachment hangs off. */
  function attachmentObject(type: FakeAttachmentObjectType, id: number): { project: number } | undefined {
    const objects: { id: number; project: number }[] = type === 'wiki' ? state.wikiPages : itemsOf(ITEM_KINDS[type].itemType);
    return objects.find((o) => o.id === id);
  }

  /** POST /{type}/attachments: taiga-back's AttachmentValidator + BaseAttachmentViewSet.pre_save. */
  function createAttachment(type: FakeAttachmentObjectType, body: unknown, userId: number): Reply {
    if (!(body instanceof MultipartForm)) throw fieldErrors({ attached_file: ['No file was submitted.'] });
    const errors: Record<string, string[]> = {};
    unknownFields({ ...body.fields, ...body.files }, ATTACHMENT_FIELDS, errors);
    const file = body.files.attached_file;
    if (!file) errors.attached_file = ['No file was submitted.'];
    const projectId = Number(body.fields.project);
    const objectId = Number(body.fields.object_id);
    if (body.fields.project === undefined) errors.project = ['This field is required.'];
    else if (!Number.isInteger(projectId) || !visibleProject(projectId, userId)) errors.project = [`Invalid pk "${body.fields.project}" - object does not exist.`];
    if (body.fields.object_id === undefined) errors.object_id = ['This field is required.'];
    else if (!Number.isInteger(objectId) || objectId < 0) errors.object_id = ['A valid integer is required.'];
    if (Object.keys(errors).length > 0) throw fieldErrors(errors);
    const object = attachmentObject(type, objectId);
    if (!object) throw new HttpError(400, { _error_message: "Object id issue doesn't exist", _error_type: 'taiga.base.exceptions.WrongArguments' });
    if (object.project !== projectId) {
      throw new HttpError(400, { _error_message: 'Project ID does not match between object and project', _error_type: 'taiga.base.exceptions.WrongArguments' });
    }
    const name = file!.filename.split(/[\\/]/).pop()!;
    const attachment = addAttachment({ project: projectId, objectType: type, object_id: objectId, name, content: file!.content, description: body.fields.description });
    attachment.is_deprecated = body.fields.is_deprecated?.toLowerCase() === 'true';
    attachment.from_comment = body.fields.from_comment?.toLowerCase() === 'true';
    return { status: 201, body: attachmentJson(attachment) };
  }

  function routeAttachments(req: IncomingMessage, method: string, path: string, query: URLSearchParams, body: unknown, userId: number): Reply | undefined {
    const match = /^\/(epics|userstories|tasks|wiki)\/attachments$/.exec(path);
    if (!match) return undefined;
    const type = match[1] as FakeAttachmentObjectType;
    if (method === 'POST') return createAttachment(type, body, userId);
    if (method !== 'GET') return undefined;
    const projectId = queryNumber(query, 'project');
    const objectId = queryNumber(query, 'object_id');
    const list = state.attachments.filter(
      (a) =>
        a.objectType === type &&
        visibleProject(a.project, userId) &&
        (projectId === undefined || a.project === projectId) &&
        (objectId === undefined || a.object_id === objectId),
    );
    return paginate(req, query, list.map(attachmentJson));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const at = performance.now();
    const url = new URL(req.url ?? '/', 'http://fake');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] ?? '';
    let reply: Reply;
    let body: unknown;
    if (settings.maxBodyBytes !== undefined && bytes.length > settings.maxBodyBytes) {
      // The reverse proxy refuses the request before Taiga sees it, with its own HTML page.
      requests.push({ method: req.method ?? 'GET', path: url.pathname.replace(/^\/api\/v1(?=\/)/, ''), query: url.searchParams, headers: req.headers, body: undefined, at });
      res.writeHead(413, { 'content-type': 'text/html' });
      res.end(NGINX_413);
      return;
    }
    if (/^multipart\/form-data\s*;/i.test(contentType)) {
      body = await parseMultipart(bytes, contentType);
    } else {
      const raw = bytes.toString('utf8');
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const path = url.pathname.startsWith('/api/v1/') ? url.pathname.slice('/api/v1'.length) : undefined;
    const method = req.method ?? 'GET';
    const request: RecordedRequest = { method, path: path ?? url.pathname, query: url.searchParams, headers: req.headers, body, at };
    requests.push(request);
    try {
      if (path === undefined) throw notFound();
      if (typeof body === 'string') throw new HttpError(400, { _error_message: 'JSON parse error' });
      runHooks(method, path);
      const rule = takeIntercept(method, path);
      const replyBody = rule?.bodyFrom ? rule.bodyFrom(request) : rule?.body;
      reply = rule ? { status: rule.status, body: replyBody, headers: rule.headers } : route(req, path, url.searchParams, body);
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
    editAttributeValues,
    addMembership,
    addWikiPage,
    addAttachment,
    intercept: (rule) => void intercepts.push({ ...rule }),
    addUserStory,
    addTask,
    addIssue,
    addEpicRelatedUserStory,
    editItem,
    editWikiPage,
    onRequest: (hook) => void hooks.push({ ...hook }),
    issuedTokens,
    issueToken: () => issueTokens(user.id).auth_token,
    expireTokens: (options = {}) => {
      pendingExpiry = { after: options.after ?? 0, refresh: options.refresh ?? false };
    },
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
      return promise;
    },
  };
}

// `taigent members` and `taigent assign`: list a project's members, and set the assignee of existing user stories.
// Manifests and `apply` never write assignees (docs/taiga/conventions.md §6); `assign` is the one command that does,
// run by a person through the review gate.
//
// `assign` is planned first and idempotent: a story assigned to exactly that user is left as it is. The user and every
// ref are checked before anything is written.

import { summarize, tally, type PlanSummary } from './operations.ts';
import { type TaigaClient, TaigaConflictError, type TaigaStory } from './taiga/client.ts';

/** An unknown or ambiguous user, or a ref that is no user story of the project. Maps to ExitCode.Usage. */
export class AssignError extends Error {}

interface AssignProject {
  id: number;
  slug: string;
  name: string;
}

/** A project member as `members` lists it (an accepted membership: pending invitations have no user). */
export interface Member {
  id: number;
  username: string;
  fullName: string;
  /** The member's role name, null when Taiga does not say. */
  role: string | null;
}

export interface MemberList {
  project: AssignProject;
  /** Sorted by username. */
  members: Member[];
}

/** A user as an assign plan names them: `user <id>` for someone who is no longer a member. */
export interface Assignee {
  id: number;
  username: string | null;
  fullName: string | null;
}

export type AssignAction = 'update' | 'skip';
export interface AssignOperation {
  action: AssignAction;
  ref: number;
  id: number;
  subject: string;
  /** Who the story is assigned to before (main assignee first); empty when unassigned. */
  from: Assignee[];
  /** Why a story is skipped: already assigned to exactly the user, or (--only-unassigned) to someone. Null for an update. */
  skip: 'same' | 'assigned' | null;
  /** OCC version read with the story. */
  version: number;
}

/** `assign`: one operation per story, `update` (assigned or reassigned) or `skip`. */
export interface AssignPlan extends PlanSummary<AssignAction> {
  project: AssignProject;
  user: Assignee;
  onlyUnassigned: boolean;
  operations: AssignOperation[];
}

const ACTIONS = ['update', 'skip'] as const;

function assignProject(project: AssignProject): AssignProject {
  return { id: project.id, slug: project.slug, name: project.name };
}

/** The accepted memberships of the project, with usernames from the project's members. */
async function projectMembers(client: TaigaClient, project: { id: number; members: { id: number; username: string }[] }): Promise<Member[]> {
  const usernames = new Map(project.members.map((member) => [member.id, member.username]));
  const members: Member[] = [];
  for (const membership of await client.listMemberships(project.id)) {
    if (membership.user === null) continue;
    const username = usernames.get(membership.user);
    if (username === undefined) continue; // not an active member of the project (e.g. a deactivated account)
    members.push({ id: membership.user, username, fullName: membership.fullName ?? username, role: membership.roleName });
  }
  return members.sort((a, b) => a.username.localeCompare(b.username) || a.id - b.id);
}

/** Every member of `slug`. Read-only. */
export async function readMembers(client: TaigaClient, slug: string): Promise<MemberList> {
  const project = await client.getProjectBySlug(slug);
  return { project: assignProject(project), members: await projectMembers(client, project) };
}

function describeMember(member: { username: string; fullName: string }): string {
  return member.fullName && member.fullName !== member.username ? `${member.username} (${member.fullName})` : member.username;
}

export function formatMembersText({ project, members }: MemberList): string {
  const lines = [`Members of project ${project.name} (${project.slug}): ${members.length === 0 ? 'none' : members.length}`];
  for (const member of members) lines.push(`  ${describeMember(member)}  ${member.role ?? 'no role'}  (id ${member.id})`);
  return `${lines.join('\n')}\n`;
}

function memberList(members: Member[]): string {
  return members.length === 0 ? ' (it has no member)' : `; its members: ${members.map(describeMember).join(', ')}`;
}

/**
 * The member `user` names: `me` (the user the CLI logs in as), else the exact username, else the full name (any
 * case). Unknown or ambiguous: an AssignError listing the members.
 */
async function resolveUser(client: TaigaClient, slug: string, members: Member[], user: string): Promise<Member> {
  if (user === 'me') {
    const me = await client.getMe();
    const found = members.find((member) => member.id === me.id);
    if (!found) throw new AssignError(`you (${me.username}) are not a member of ${slug}${memberList(members)}`);
    return found;
  }
  const byUsername = members.find((member) => member.username === user);
  if (byUsername) return byUsername;
  const wanted = user.trim().toLowerCase();
  const byName = members.filter((member) => member.fullName.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new AssignError(`"${user}" is the full name of several members of ${slug}: ${byName.map((m) => m.username).join(', ')}; use the username${memberList(members)}`);
  }
  throw new AssignError(`no member "${user}" in ${slug} (by username, or full name in any case)${memberList(members)}`);
}

/** The story's assignees, main one first (`assigned_to`, then the others of `assigned_users`). */
function assigneesOf(story: TaigaStory, members: Map<number, Member>): Assignee[] {
  const ids = [...new Set([...(story.assignedTo === null ? [] : [story.assignedTo]), ...story.assignedUsers])];
  return ids.map((id) => {
    const member = members.get(id);
    return { id, username: member?.username ?? null, fullName: member?.fullName ?? null };
  });
}

/**
 * Plans assigning the user stories `refs` of `slug` to the member `user` (see `resolveUser`): `skip` for a story
 * assigned to exactly that user, and with `onlyUnassigned` for one assigned to anyone. An unknown or ambiguous user, or
 * a ref that is no user story of the project, is an AssignError, before anything is written.
 */
export async function planAssign(client: TaigaClient, slug: string, user: string, refs: number[], options: { onlyUnassigned?: boolean } = {}): Promise<AssignPlan> {
  const project = await client.getProjectBySlug(slug);
  const [members, stories] = await Promise.all([projectMembers(client, project), client.listStories(project.id)]);
  const target = await resolveUser(client, slug, members, user);
  const byRef = new Map(stories.map((story) => [story.ref, story]));
  const missing = refs.filter((ref) => !byRef.has(ref));
  if (missing.length > 0) throw new AssignError(`not a user story of ${slug}: ${[...new Set(missing)].map((ref) => `#${ref}`).join(', ')}; nothing was written`);
  const byId = new Map(members.map((member) => [member.id, member]));
  const onlyUnassigned = options.onlyUnassigned === true;
  const operations = [...new Set(refs)].map((ref): AssignOperation => {
    const story = byRef.get(ref)!;
    const from = assigneesOf(story, byId);
    const same = story.assignedTo === target.id && from.length === 1;
    const skip = same ? 'same' : onlyUnassigned && from.length > 0 ? 'assigned' : null;
    return { action: skip ? 'skip' : 'update', ref, id: story.id, subject: story.subject, from, skip, version: story.version };
  });
  return {
    project: assignProject(project),
    user: { id: target.id, username: target.username, fullName: target.fullName },
    onlyUnassigned,
    operations,
    ...summarize(ACTIONS, operations),
  };
}

/** Runs an assign plan in order (PATCH with each story's version, OCC); a conflict names the story's ref. */
export async function executeAssign(plan: AssignPlan, client: TaigaClient) {
  const operations = [];
  for (const op of plan.operations) {
    if (op.action === 'update') {
      try {
        await client.editStory(op.id, { assigned_to: plan.user.id, assigned_users: [plan.user.id] }, op.version);
      } catch (error) {
        if (error instanceof TaigaConflictError) throw new TaigaConflictError(error.message, `#${op.ref}`);
        throw error;
      }
    }
    operations.push({ ...op, result: op.action === 'update' ? ('updated' as const) : ('unchanged' as const) });
  }
  return { project: plan.project, user: plan.user, operations, summary: tally(ACTIONS, plan.operations) };
}

/** How a plan names a user: `alice (Alice Nguyen)`, or `user 7` for someone who is no longer a member. */
export function describeAssignee(user: Assignee): string {
  return user.username === null ? `user ${user.id}` : describeMember({ username: user.username, fullName: user.fullName ?? user.username });
}

export function describeAssignOperation(op: AssignOperation): string {
  const names = op.from.map(describeAssignee).join(', ');
  if (op.action === 'skip') return `story #${op.ref} ${op.subject}  (already assigned to ${names})`;
  return `story #${op.ref} ${op.subject}${names ? `  (from ${names})` : '  (unassigned)'}`;
}

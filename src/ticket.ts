// `taigent status` and `taigent comment`: edit one ticket (GLOSSARY.md) of the authenticated user, named by its ref in
// one project. Only the user's own tickets can be edited: a story assigned to someone else is not found.

import { type TaigaAssignedStory, type TaigaClient, TaigaConflictError, type TaigaStoryStatus } from './taiga/client.ts';

/** The ticket, status or ref the user named does not exist (for them). Maps to ExitCode.Usage. */
export class TicketError extends Error {}

const REF = /^#?(\d+)$/;

/** The ref of `84` or `#84`, or undefined. */
export function parseRef(value: string): number | undefined {
  const match = REF.exec(value);
  return match ? Number(match[1]) : undefined;
}

/** How the output names a ticket. */
export interface TicketRef {
  id: number;
  ref: number;
  subject: string;
  project: { id: number; slug: string; name: string };
}

/** The `--json` output of `taigent status`. */
export interface StatusChange {
  ticket: TicketRef;
  from: string;
  to: string;
  /** Whether the new status is a closed one (`Done`, `Archived` in the default template). */
  isClosed: boolean;
  /** False when the ticket already had that status: nothing was written. */
  changed: boolean;
}

/** The `--json` output of `taigent comment`. */
export interface CommentAdded {
  ticket: TicketRef;
  comment: string;
}

/** The story `#ref` of project `slug` assigned to the authenticated user, or a TicketError. */
async function findOwnTicket(client: TaigaClient, slug: string, ref: number): Promise<TaigaAssignedStory> {
  const project = await client.getProjectBySlug(slug);
  const me = await client.getMe();
  const story = (await client.listAssignedStories(me.id, project.id)).find((candidate) => candidate.ref === ref);
  if (!story) throw new TicketError(`#${ref} is not a ticket of ${me.username} in ${slug} (no user story #${ref} assigned to them)`);
  return story;
}

/** The status named `name` (trimmed, any case; its slug works too), or a TicketError listing the valid ones. */
function findStatus(statuses: TaigaStoryStatus[], name: string, slug: string): TaigaStoryStatus {
  const wanted = name.trim().toLowerCase();
  const status = statuses.find((candidate) => candidate.name.trim().toLowerCase() === wanted || candidate.slug === wanted);
  if (!status) throw new TicketError(`unknown user story status "${name}" in ${slug}; use one of: ${statuses.map((s) => s.name).join(', ')}`);
  return status;
}

/** A conflict names the ticket, like apply names the item key. */
async function withTicketKey<T>(ref: number, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof TaigaConflictError) throw new TaigaConflictError(error.message, `#${ref}`);
    throw error;
  }
}

/** Moves the user's ticket `#ref` of `slug` to the status named `statusName`; writes nothing when it already has it. */
export async function setTicketStatus(client: TaigaClient, slug: string, ref: number, statusName: string): Promise<StatusChange> {
  const story = await findOwnTicket(client, slug, ref);
  const status = findStatus(await client.listStoryStatuses(story.project.id), statusName, slug);
  const changed = status.name !== story.status;
  if (changed) await withTicketKey(ref, () => client.editStory(story.id, { status: status.id }, story.version));
  return { ticket: { id: story.id, ref: story.ref, subject: story.subject, project: story.project }, from: story.status, to: status.name, isClosed: status.isClosed, changed };
}

/** Adds `comment` to the user's ticket `#ref` of `slug`. */
export async function commentTicket(client: TaigaClient, slug: string, ref: number, comment: string): Promise<CommentAdded> {
  const story = await findOwnTicket(client, slug, ref);
  await withTicketKey(ref, () => client.editStory(story.id, { comment }, story.version));
  return { ticket: { id: story.id, ref: story.ref, subject: story.subject, project: story.project }, comment };
}

// `taigent notify`: the week, day and end-of-day messages about the user's tickets (GLOSSARY.md), sent to the
// user's Telegram chat through the Bot API. The messages are built from `readTickets` alone; the bot token and chat
// come from the environment or from the state directory of the Claude Code Telegram plugin (the same bot).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { addDays, localDay, longDay, mondayOf, shortDay, weekdayName } from './days.ts';
import { isFileNotFound, isRecord } from './guards.ts';
import { isTicket, type Ticket, type TicketId, type TicketsReport, ticketLabel } from './tickets.ts';

export const NOTIFY_KINDS = ['week', 'day', 'eod'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** Telegram configuration is missing or ambiguous. Maps to ExitCode.Usage. */
export class NotifyConfigError extends Error {}

/** The Telegram Bot API refused the message or could not be reached. Maps to ExitCode.Taiga (network). Never holds the token. */
export class TelegramError extends Error {}

/** The days a message covers, YYYY-MM-DD in local time: the week of `now` (Monday to Sunday) or the day of `now`. */
export function notifyRange(kind: NotifyKind, now: Date): { from: string; to: string } {
  const today = localDay(now);
  if (kind !== 'week') return { from: today, to: today };
  const monday = mondayOf(today);
  return { from: monday, to: addDays(monday, 6) };
}

function ticketLine(ticket: Ticket, extra = ''): string {
  const due = ticket.dueDate === null ? 'chưa có hạn' : `hạn ${shortDay(ticket.dueDate)}`;
  return `• #${ticket.ref} ${ticket.subject} — ${ticket.status} · ${ticket.dueStatus ?? '?'} · ${due} (${ticket.project.slug})${extra}`;
}

/** A titled list of lines, or nothing when there are none. */
function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ['', `${title} (${lines.length}):`, ...lines];
}

/**
 * The message of `kind`, in Vietnamese (the team's language), from the report alone, or null when there is nothing to
 * say: `eod` with no unfinished planned ticket due by today.
 * - `week`: the whole plan and every warning.
 * - `day`: the plan's entries of today, tickets whose latest start day is today, Due today and Overdue.
 * - `eod` (end-of-day reminder): unfinished planned tickets due today or earlier, their re-plan (from a report planned
 *   from the next working day, `readTickets`' `endOfDay`), and how to move them to Ready for test or approve the
 *   re-plan from the chat.
 */
export function notifyMessage(kind: NotifyKind, report: TicketsReport): string | null {
  const scope = report.project === null ? '' : ` · ${report.project}`;
  const open = report.tickets.filter((ticket) => !ticket.isFinished);
  const byId = (id: TicketId) => report.tickets.find((ticket) => isTicket(ticket, id))!;
  const listed = (ids: TicketId[], extra: (ticket: Ticket) => string = () => '') => ids.map(byId).map((ticket) => ticketLine(ticket, extra(ticket)));
  const { warnings } = report;
  if (kind === 'week') {
    const count = report.summary.byProgress;
    const lines = [
      `📅 Tuần ${shortDay(report.range.from)} – ${longDay(report.range.to)} · ${report.user.username}${scope}`,
      `Chưa xong ${open.length} ticket (Ready ${count.Ready}, In progress ${count['In progress']}), chờ test ${count['Ready for test']}, đã Done ${count.Done}.`,
      '',
    ];
    if (report.plan.days.length === 0) lines.push('Kế hoạch: không còn việc nào để xếp.');
    else {
      lines.push(`Kế hoạch (từ ${shortDay(report.plan.start)}):`);
      // `#12` for a ticket of --project or of the one project all the tickets belong to; else `alpha#12`.
      const home = report.project ?? (report.summary.projects.length === 1 ? report.summary.projects[0]!.slug : null);
      for (const day of report.plan.days) {
        const entries = day.entries.map((entry) => `${ticketLabel(entry, home)} (${entry.hours}h)`).join(', ');
        lines.push(`• ${weekdayName(day.date, 'vi')} ${shortDay(day.date)} — ${day.hours}h: ${entries}`);
      }
    }
    lines.push(
      ...section('Quá hạn', listed(warnings.overdue)),
      ...section('Chưa có hạn', listed(warnings.noDueDate)),
      ...section('Chưa có point', listed(warnings.noPoints)),
      ...section('Đã tới ngày phải bắt đầu mà còn Ready', listed(warnings.lateStart, (ticket) => ` · bắt đầu muộn nhất ${shortDay(ticket.latestStartDay!)}`)),
      ...section('Có nguy cơ trễ hạn', listed(warnings.atRisk, (ticket) => {
        const sharing = ticket.sharingTickets.length === 0 ? '' : `, chung ngày với ${ticket.sharingTickets.map((id) => ticketLabel(id, ticket.project.slug)).join(', ')}`;
        return ` · dự kiến xong ${shortDay(ticket.plannedFinishDay!)}${sharing}`;
      })),
    );
    return lines.join('\n');
  }
  const overdue = open.filter((ticket) => ticket.dueStatus === 'Overdue');
  const dueToday = open.filter((ticket) => ticket.dueStatus === 'Due today');
  if (kind === 'day') {
    const lines = [`☀️ Hôm nay ${weekdayName(report.today, 'vi')} ${longDay(report.today)} · ${report.user.username}${scope}`, ''];
    const today = report.plan.days.find((day) => day.date === report.today);
    if (today === undefined) lines.push('Kế hoạch không xếp việc nào cho hôm nay.');
    else {
      lines.push(`Kế hoạch hôm nay (${today.hours}h):`);
      for (const entry of today.entries) {
        const ticket = byId(entry);
        lines.push(`• #${ticket.ref} ${ticket.subject} — ${entry.hours}h (${ticket.project.slug})`);
      }
    }
    const startToday = open.filter((ticket) => ticket.latestStartDay === report.today);
    lines.push(...section('Phải bắt đầu hôm nay', startToday.map((t) => ticketLine(t))), ...section('Đến hạn hôm nay', dueToday.map((t) => ticketLine(t))), ...section('Quá hạn', overdue.map((t) => ticketLine(t))));
    return lines.join('\n');
  }
  const pending = open.filter((ticket) => ticket.dueDate !== null && ticket.dueDate <= report.today);
  if (pending.length === 0) return null;
  const replan = report.replan.filter((entry) => pending.some((ticket) => isTicket(ticket, entry)));
  const lines = [`⏰ Cuối ngày ${longDay(report.today)}: bạn còn ${pending.length} ticket đến hạn hôm nay hoặc trước đó mà chưa xong${scope}.`, ...pending.map((t) => ticketLine(t))];
  if (replan.length > 0) {
    lines.push('', 'Đề xuất dời hạn (re-plan):');
    for (const entry of replan) lines.push(`• #${entry.ref} ${entry.subject}: ${shortDay(entry.dueDate)} → ${shortDay(entry.proposedDueDate)} — ${entry.comment}`);
  }
  const approve = replan.length > 0 ? '; đồng ý dời hạn thì nhắn "duyệt re-plan"' : '';
  lines.push('', `Xong rồi thì nhắn "đóng hết" hoặc "đóng #<số>" để chuyển sang Ready for test (chờ QA/QC)${approve}.`);
  return lines.join('\n');
}

/** Where `notify` sends: the bot token, the chat and the Bot API base URL. */
export interface TelegramTarget {
  token: string;
  chatId: string;
  apiUrl: string;
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * TELEGRAM_BOT_TOKEN (environment or ./.env), else the one `/telegram:configure` saved in the plugin's `.env`;
 * TELEGRAM_CHAT_ID, else the single paired user of the plugin's `access.json` (`allowFrom`: a DM's chat id is the
 * user id). The plugin's state directory is TELEGRAM_STATE_DIR, else `<CLAUDE_CONFIG_DIR or ~/.claude>/channels/telegram`.
 * TAIGENT_TELEGRAM_API_URL overrides the Bot API (tests).
 */
export function resolveTelegram(env: NodeJS.ProcessEnv): TelegramTarget {
  const stateDir = env.TELEGRAM_STATE_DIR || join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'channels', 'telegram');
  const envFile = readOptional(join(stateDir, '.env'));
  const token = env.TELEGRAM_BOT_TOKEN || (envFile === undefined ? undefined : parseEnv(envFile).TELEGRAM_BOT_TOKEN);
  if (!token) {
    throw new NotifyConfigError(`no Telegram bot token: set TELEGRAM_BOT_TOKEN, or run /telegram:configure <token> in Claude Code (writes ${join(stateDir, '.env')})`);
  }
  let chatId = env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    const accessPath = join(stateDir, 'access.json');
    const access = readOptional(accessPath);
    let allowFrom: unknown[] = [];
    if (access !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(access);
      } catch {
        throw new NotifyConfigError(`${accessPath} is not valid JSON`);
      }
      if (isRecord(parsed) && Array.isArray(parsed.allowFrom)) allowFrom = parsed.allowFrom;
    }
    const ids = allowFrom.filter((id): id is string => typeof id === 'string' && /^-?\d+$/.test(id));
    if (ids.length !== 1) {
      const why = ids.length === 0 ? 'no paired Telegram user' : `${ids.length} paired Telegram users`;
      throw new NotifyConfigError(`${why} in ${accessPath}: set TELEGRAM_CHAT_ID to your chat id, or pair once with /telegram:access pair <code>`);
    }
    chatId = ids[0]!;
  }
  return { token, chatId, apiUrl: (env.TAIGENT_TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/+$/, '') };
}

/** Telegram's limit for one message's text. */
const MAX_MESSAGE = 4096;

/** `text` cut at line breaks into messages of at most MAX_MESSAGE characters (a longer line is cut where it must). */
export function chunkMessage(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    for (let rest = line; ; ) {
      const candidate = current === '' ? rest : `${current}\n${rest}`;
      if (candidate.length <= MAX_MESSAGE) {
        current = candidate;
        break;
      }
      if (current !== '') {
        chunks.push(current);
        current = '';
        continue;
      }
      chunks.push(rest.slice(0, MAX_MESSAGE));
      rest = rest.slice(MAX_MESSAGE);
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** `POST /bot<token>/sendMessage` for each chunk of `text`, as plain text (no parse mode, nothing to escape). */
export async function sendTelegram(target: TelegramTarget, text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    let response: Response;
    try {
      response = await fetch(`${target.apiUrl}/bot${target.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: target.chatId, text: chunk }),
      });
    } catch (error) {
      const reason = error instanceof Error && error.cause !== undefined ? error.cause : error;
      throw new TelegramError(`cannot reach the Telegram Bot API at ${target.apiUrl}: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(body) || body.ok !== true) {
      const description = isRecord(body) && typeof body.description === 'string' ? `: ${body.description}` : '';
      throw new TelegramError(`Telegram refused the message to chat ${target.chatId}: HTTP ${response.status}${description}`);
    }
  }
}

// `taigent notify`: the week, day and end-of-day messages about the user's tickets (GLOSSARY.md), sent to the
// user's Telegram chat through the Bot API. The messages are built from `readTickets` alone; the bot token and chat
// come from the environment or from the state directory of the Claude Code Telegram plugin (the same bot).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { addDays, localDay, mondayOf } from './days.ts';
import { isFileNotFound, isRecord } from './guards.ts';
import type { Ticket, TicketsReport } from './tickets.ts';

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

/** `30/10` from `2026-10-30`. */
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
/** `30/10/2026` from `2026-10-30`. */
const longDay = (day: string) => `${shortDay(day)}/${day.slice(0, 4)}`;

function ticketLine(ticket: Ticket): string {
  const due = ticket.dueDate === null ? 'chưa có hạn' : `hạn ${shortDay(ticket.dueDate)}`;
  return `• #${ticket.ref} ${ticket.subject} — ${ticket.status} · ${due} (${ticket.project.slug})`;
}

/** A titled list of tickets, or nothing when there are none. */
function section(title: string, tickets: Ticket[]): string[] {
  return tickets.length === 0 ? [] : ['', `${title} (${tickets.length}):`, ...tickets.map(ticketLine)];
}

/**
 * The message of `kind`, in Vietnamese (the team's language), or null when there is nothing to say: `eod` with no
 * open ticket due by today.
 * - `week`: every open ticket by due status (Overdue, due this week, due later, no due date), and those closed so far.
 * - `day`: open tickets due today and Overdue ones, and how many others are open.
 * - `eod`: open tickets due today or Overdue, with how to close them from the chat.
 */
export function notifyMessage(kind: NotifyKind, report: TicketsReport): string | null {
  const open = report.tickets.filter((ticket) => !ticket.isClosed);
  const overdue = open.filter((ticket) => ticket.dueStatus === 'Overdue');
  const scope = report.project === null ? '' : ` · ${report.project}`;
  if (kind === 'week') {
    const dueThisWeek = open.filter((ticket) => ticket.dueDate !== null && ticket.dueDate >= report.range.from && ticket.dueDate <= report.range.to);
    const dueLater = open.filter((ticket) => ticket.dueDate !== null && ticket.dueDate > report.range.to);
    const noDueDate = open.filter((ticket) => ticket.dueDate === null);
    const closed = report.tickets.filter((ticket) => ticket.closedAt !== null && Date.parse(ticket.closedAt) >= Date.parse(report.range.start));
    return [
      `📅 Tuần ${shortDay(report.range.from)} – ${longDay(report.range.to)} · ${report.user.username}${scope}`,
      `Đang mở ${open.length} ticket: quá hạn ${overdue.length}, đến hạn trong tuần ${dueThisWeek.length}, hạn sau ${dueLater.length}, chưa có hạn ${noDueDate.length}.`,
      ...section('Quá hạn', overdue),
      ...section('Đến hạn trong tuần', dueThisWeek),
      ...section('Hạn sau tuần này', dueLater),
      ...section('Chưa có hạn', noDueDate),
      ...section('Đã đóng trong tuần', closed),
    ].join('\n');
  }
  const dueToday = open.filter((ticket) => ticket.dueDate === report.today);
  if (kind === 'day') {
    const others = open.length - dueToday.length - overdue.length;
    const lines = [`☀️ Hôm nay ${longDay(report.today)} · ${report.user.username}${scope}`];
    if (dueToday.length === 0 && overdue.length === 0) lines.push('Không có ticket nào đến hạn hôm nay hoặc quá hạn.');
    lines.push(...section('Đến hạn hôm nay', dueToday), ...section('Quá hạn', overdue), '', `Còn mở khác: ${others} ticket.`);
    return lines.join('\n');
  }
  const pending = open.filter((ticket) => ticket.dueDate !== null && ticket.dueDate <= report.today);
  if (pending.length === 0) return null;
  return [
    `⏰ Cuối ngày ${longDay(report.today)}: bạn còn ${pending.length} ticket đến hạn chưa đóng${scope}.`,
    ...pending.map(ticketLine),
    '',
    'Xong rồi thì nhắn "đóng hết" hoặc "đóng #<số>" để chuyển sang Done.',
  ].join('\n');
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

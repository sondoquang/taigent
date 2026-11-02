// Taiga > Ticket của tôi: the Period's tickets (`taigent tickets --from --to --json`) with each project's user story
// statuses (`projects --project <slug> --json`), and the two writes on one ticket of the user, `status` and `comment`.
// Each write runs only after a native confirmation (ADR 0003: writes go through the CLI after a confirmation step).

import { type BrowserWindow, dialog } from 'electron';
import type { ProjectDetailReport } from '../../../src/projects.ts';
import type { CommentAdded, StatusChange } from '../../../src/ticket.ts';
import type { TicketsReport } from '../../../src/tickets.ts';
import type { Failure, MyTickets, Result, TicketCommentRequest, TicketStatusRequest, TicketWriteOutcome } from '../shared/api.ts';
import { failure } from './project.ts';
import { type CliError, parseCliJson, runCli } from './taigent.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

const LOGIN_FIX = 'Cách sửa: bấm “Đăng nhập” ở thanh trên cùng (hoặc chạy npx taigent login trong terminal), rồi bấm Làm mới.';

/**
 * The CLI's error as the screen says it, in Vietnamese with how to fix it. `write` names the ticket of a failed write;
 * the errors the CLI raises before writing (login, conflict, not your ticket, unknown status) then say nothing was written.
 */
function ticketFailure(error: CliError | undefined, write?: { slug: string; ref: number }): Failure {
  const detail = error?.message;
  const nothing = write ? ' Chưa ghi gì lên Taiga.' : '';
  const ticket = write ? `#${write.ref} (${write.slug})` : '';
  if (error?.kind === 'login') return failure(`Chưa đăng nhập Taiga.${nothing} ${LOGIN_FIX}`, { detail });
  if (error?.kind === 'conflict') {
    return failure(
      `Ticket ${ticket} vừa được đổi trên Taiga (người khác, hoặc bạn ở nơi khác) sau khi taigent đọc nó.${nothing} ` +
        'Cách sửa: danh sách đã được làm mới; xem lại ticket rồi thử lại.',
      { detail },
    );
  }
  if (error?.kind === 'usage' && detail && /is not a ticket of/.test(detail)) {
    return failure(
      `${ticket} không phải ticket của bạn: không có user story #${write?.ref} nào trong ${write?.slug} đang giao cho bạn.${nothing} ` +
        'Cách sửa: danh sách đã được làm mới; nếu ticket vừa được giao cho người khác, nhờ họ, hoặc nhờ giao lại cho bạn trên Taiga.',
      { detail },
    );
  }
  if (error?.kind === 'usage' && detail && /unknown user story status/.test(detail)) {
    return failure(`Project ${write?.slug} không còn status này.${nothing} Cách sửa: danh sách status đã được tải lại; chọn lại status.`, { detail });
  }
  if (error?.kind === 'taiga' && (error.status === 401 || (detail !== undefined && /taigent login|TAIGA_TOKEN|TAIGA_USERNAME/.test(detail)))) {
    return failure(
      `Đăng nhập Taiga đã hết hạn hoặc bị từ chối.${nothing} Cách sửa: bấm tên của bạn → Đăng xuất, rồi Đăng nhập lại ` +
        '(đăng nhập hết hạn sau 8 ngày không dùng); nếu repo đặt TAIGA_TOKEN hoặc TAIGA_USERNAME/TAIGA_PASSWORD (.env) thì sửa các biến đó.',
      { detail },
    );
  }
  if (write) {
    return failure(
      `Không ghi được lên ticket ${ticket}. Cách sửa: kiểm tra mạng và URL API Taiga, rồi bấm Làm mới để xem ticket trên Taiga trước khi thử lại.`,
      { detail },
    );
  }
  return failure('Không đọc được ticket của bạn trên Taiga. Cách sửa: kiểm tra mạng và URL API Taiga, rồi bấm Làm mới.', { detail });
}

/** The Period's tickets from `from` to `to`, and the user story statuses of every project holding one. */
export async function readMyTickets(root: string, from: string, to: string): Promise<Result<MyTickets>> {
  if (!DAY.test(from) || !DAY.test(to)) return failure('Hãy chọn ngày bắt đầu và ngày kết thúc của kỳ.');
  if (from > to) return failure('Ngày bắt đầu đang sau ngày kết thúc. Cách sửa: chọn lại kỳ.');
  const run = await runCli(['tickets', '--from', from, '--to', to, '--json'], root);
  const { value: report, error } = parseCliJson<TicketsReport>(run);
  if (!report) return ticketFailure(error);
  const slugs = [...new Set(report.tickets.map((ticket) => ticket.project.slug))];
  const details = await Promise.all(slugs.map((slug) => runCli(['projects', '--project', slug, '--json'], root).then(parseCliJson<ProjectDetailReport>)));
  const statuses: MyTickets['statuses'] = {};
  slugs.forEach((slug, index) => {
    const detail = details[index]!;
    statuses[slug] = detail.value
      ? { statuses: detail.value.storyStatuses }
      : { message: `Không đọc được status của ${slug}: ${detail.error?.message ?? 'lỗi không rõ'}. Bấm Làm mới để thử lại.` };
  });
  return { ok: true, value: { report, statuses } };
}

function validWrite(slug: string, ref: number): Failure | undefined {
  if (!SLUG.test(slug)) return failure(`"${slug}" không phải slug project.`);
  if (!Number.isInteger(ref) || ref <= 0) return failure(`"${ref}" không phải ref ticket.`);
  return undefined;
}

async function confirm(window: BrowserWindow, title: string, message: string, detail: string, button: string): Promise<boolean> {
  const { response } = await dialog.showMessageBox(window, { type: 'question', title, message, detail, buttons: [button, 'Huỷ'], defaultId: 1, cancelId: 1, noLink: true });
  return response === 0;
}

/** "Đổi status": a native confirmation, then `taigent status`; a ticket already at `to` is left unchanged by the CLI. */
export async function setTicketStatus(root: string, request: TicketStatusRequest, window: BrowserWindow): Promise<Result<TicketWriteOutcome<StatusChange>>> {
  const { slug, ref, subject, from, to, closes } = request;
  const invalid = validWrite(slug, ref) ?? (to.trim() === '' ? failure('Hãy chọn status.') : undefined);
  if (invalid) return invalid;
  const closing = closes ? '\n\nĐây là status đóng: ticket sẽ được đóng và Taiga ghi lại thời điểm đóng.' : '';
  const ok = await confirm(window, 'Đổi status ticket', `Đổi status #${ref} ${subject} sang “${to}”?`, `Dự án: ${slug}\nStatus hiện tại: ${from}${closing}`, 'Đổi status');
  if (!ok) return { ok: true, value: { status: 'cancelled' } };
  const run = await runCli(['status', '--project', slug, '--json', String(ref), '--', to], root);
  const { value, error } = parseCliJson<StatusChange>(run);
  return value ? { ok: true, value: { status: 'done', value } } : ticketFailure(error, { slug, ref });
}

/** "Gửi comment": a native confirmation, then `taigent comment` with the text as one argument after `--`. */
export async function commentTicket(root: string, request: TicketCommentRequest, window: BrowserWindow): Promise<Result<TicketWriteOutcome<CommentAdded>>> {
  const { slug, ref, subject } = request;
  const text = request.text.trim();
  const invalid = validWrite(slug, ref) ?? (text === '' ? failure('Comment đang trống.') : undefined);
  if (invalid) return invalid;
  const ok = await confirm(window, 'Gửi comment', `Gửi comment lên #${ref} ${subject}?`, `Dự án: ${slug}\n\n${text}`, 'Gửi comment');
  if (!ok) return { ok: true, value: { status: 'cancelled' } };
  const run = await runCli(['comment', '--project', slug, '--json', String(ref), '--', text], root);
  const { value, error } = parseCliJson<CommentAdded>(run);
  return value ? { ok: true, value: { status: 'done', value } } : ticketFailure(error, { slug, ref });
}

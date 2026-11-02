// Taiga > Ticket của tôi: the Period's tickets of the logged-in user (`taigent tickets --json`), by default this week
// Monday to Sunday, with due status and effort. A ticket's status changes from a dropdown (`taigent status`) and a
// comment goes from a text box (`taigent comment`); the main process confirms each write first, and the list is read
// again after every write, done or failed.

import type { DueStatus, Failure, MyTickets, StoryStatusEntry, TaigentApi, Ticket } from '../shared/api.ts';
import { byId, h } from './dom.ts';
import { onSectionChange } from './navigation.ts';

export interface MyTicketsContext {
  api: TaigentApi;
  /** Who the CLI acts as (`whoami`); a change since the last read makes the panel read again when it shows. */
  loginKey(): string;
  toast(message: string, kind?: 'info' | 'error'): void;
  failureBlock(failure: Failure): HTMLElement;
}

interface Period {
  from: string;
  to: string;
}

const DUE_LABELS: Record<DueStatus, string> = {
  'On time': 'Đúng hạn',
  Late: 'Trễ hạn',
  Overdue: 'Quá hạn',
  'On track': 'Còn hạn',
  'No due date': 'Không có hạn',
};

let context: MyTicketsContext;
let period: Period;
let data: MyTickets | undefined;
let readFailure: Failure | undefined;
/** The outcome of the last write, shown above the list until the next action. */
let writeResult: HTMLElement | undefined;
let loadedAs: string | undefined;
let reading = 0;
let busy = false;
/** The ticket whose comment box is open (`slug#ref`), and the unsent text of every box. */
let commentOpen: string | undefined;
const drafts = new Map<string, string>();

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Monday to Sunday of the local week holding `day`. */
function weekOf(day: Date): Period {
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: dayOf(monday), to: dayOf(sunday) };
}

/** The week `weeks` before or after the one holding the period's first day. */
function shiftWeek(weeks: number): Period {
  const [year, month, day] = period.from.split('-').map(Number);
  return weekOf(new Date(year!, month! - 1, day! + 7 * weeks));
}

const keyOf = (ticket: Ticket) => `${ticket.project.slug}#${ticket.ref}`;

function setBusy(on: boolean): void {
  busy = on;
  for (const control of byId('taiga-tickets').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button, input, select, textarea')) {
    control.disabled = on || control.dataset.off === 'true';
  }
}

function dueLabel(ticket: Ticket): string {
  if (ticket.dueStatus === null) return 'Không rõ (đã đóng, Taiga không ghi ngày đóng)';
  return DUE_LABELS[ticket.dueStatus];
}

function effortLabel(ticket: Ticket): string {
  if (ticket.effort === null) return 'Chưa có effort';
  return ticket.effortSource === 'points' ? `${ticket.effort}h (ước tính từ points)` : `${ticket.effort}h`;
}

function closedLabel(ticket: Ticket): string {
  if (!ticket.isClosed) return '—';
  if (!ticket.closedAt) return 'Đã đóng';
  const at = new Date(ticket.closedAt);
  return `${dayOf(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function summaryLine(result: MyTickets): string {
  const { summary } = result.report;
  const closed = summary.closed.byDueStatus;
  const open = summary.open.byDueStatus;
  return (
    `${summary.tickets} ticket · đã đóng ${summary.closed.total} (đúng hạn ${closed['On time']}, trễ hạn ${closed.Late}, không có hạn ${closed['No due date']})` +
    ` · còn mở ${summary.open.total} (quá hạn ${open.Overdue}, còn hạn ${open['On track']}, không có hạn ${open['No due date']})` +
    ` · effort ${summary.effort.hours}h (thực tế ${summary.effort.spent.hours}h, ước tính từ points ${summary.effort.points.hours}h)`
  );
}

function statusCell(ticket: Ticket, result: MyTickets): HTMLElement {
  const known = result.statuses[ticket.project.slug];
  if (!known || 'message' in known) return h('td', {}, ticket.status, h('div', { class: 'muted small' }, known?.message ?? ''));
  const statuses: StoryStatusEntry[] = known.statuses.some((status) => status.name === ticket.status)
    ? known.statuses
    : [{ name: ticket.status, isClosed: ticket.isClosed }, ...known.statuses];
  const select = h(
    'select',
    { class: 'ticket-status', 'aria-label': `Status của #${ticket.ref}` },
    ...statuses.map((status) => h('option', { value: status.name, selected: status.name === ticket.status }, status.isClosed ? `${status.name} (đóng)` : status.name)),
  );
  const save = h('button', { type: 'button', class: 'btn ticket-status-save', 'data-off': 'true', disabled: true }, 'Đổi status');
  select.addEventListener('change', () => {
    save.dataset.off = String(select.value === ticket.status);
    save.disabled = busy || select.value === ticket.status;
  });
  save.addEventListener('click', () => {
    const to = statuses.find((status) => status.name === select.value);
    if (to) void changeStatus(ticket, to);
  });
  return h('td', { class: 'ticket-status-cell' }, select, save);
}

function commentRow(ticket: Ticket): HTMLElement {
  const key = keyOf(ticket);
  const text = h('textarea', { class: 'ticket-comment-text', rows: '3', placeholder: 'Tiến độ, câu hỏi, link… (gửi lên Taiga dưới tên bạn)' }, drafts.get(key) ?? '');
  text.addEventListener('input', () => drafts.set(key, text.value));
  text.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' && (event as KeyboardEvent).ctrlKey) void sendComment(ticket, text.value);
  });
  return h(
    'tr',
    { class: 'ticket-comment-row', 'data-comment': key },
    h(
      'td',
      { colspan: '6' },
      text,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => toggleComment(key) }, 'Đóng'),
        h('button', { type: 'button', class: 'btn primary ticket-comment-send', onclick: () => void sendComment(ticket, text.value) }, 'Gửi comment'),
      ),
    ),
  );
}

function ticketRows(ticket: Ticket, result: MyTickets): HTMLElement[] {
  const key = keyOf(ticket);
  const due = ticket.dueStatus ?? 'unknown';
  const row = h(
    'tr',
    { 'data-ticket': key, class: ticket.isClosed ? 'closed' : '' },
    h('td', {}, h('strong', {}, `#${ticket.ref} `), ticket.subject, h('div', { class: 'muted small' }, ticket.project.name)),
    statusCell(ticket, result),
    h('td', {}, ticket.dueDate ?? '—', ' ', h('span', { class: `badge due due-${due.toLowerCase().replaceAll(' ', '-')}` }, dueLabel(ticket))),
    h('td', {}, closedLabel(ticket)),
    h('td', {}, effortLabel(ticket)),
    h('td', {}, h('button', { type: 'button', class: 'btn ghost ticket-comment-open', onclick: () => toggleComment(key) }, commentOpen === key ? 'Đóng comment' : 'Comment…')),
  );
  return commentOpen === key ? [row, commentRow(ticket)] : [row];
}

function render(): void {
  byId<HTMLInputElement>('tickets-from').value = period.from;
  byId<HTMLInputElement>('tickets-to').value = period.to;
  const status = byId('tickets-status');
  const list = byId('tickets-list');
  byId('tickets-result').replaceChildren(...(writeResult ? [writeResult] : []));
  if (readFailure) {
    status.textContent = '';
    list.removeAttribute('data-period');
    return void list.replaceChildren(context.failureBlock(readFailure));
  }
  if (!data) {
    status.textContent = 'Đang đọc ticket của bạn trên Taiga…';
    list.removeAttribute('data-period');
    return void list.replaceChildren();
  }
  const { report } = data;
  list.dataset.period = `${report.range.from}..${report.range.to}`;
  status.textContent = `Ticket của ${report.user.username}, kỳ ${report.range.from} → ${report.range.to}: đóng trong kỳ, có hạn trong kỳ, và mọi ticket còn mở (so với hôm nay, ${report.today}).`;
  if (report.tickets.length === 0) return void list.replaceChildren(h('p', { class: 'muted' }, 'Không có ticket nào trong kỳ này.'));
  const notes = [
    report.notes.missingEffort.length > 0 &&
      h('p', { class: 'muted small' }, `Chưa có effort (không có Spent Time, không có points): ${report.notes.missingEffort.map((t) => `#${t.ref} (${t.project})`).join(', ')}.`),
    ...report.notes.bulkCloses.map((run) =>
      h('p', { class: 'muted small' }, `${run.count} ticket được đóng cùng lúc (${run.tickets.map((t) => `#${t.ref}`).join(', ')}): ngày đóng có thể muộn hơn ngày làm xong.`),
    ),
  ];
  list.replaceChildren(
    h('p', { id: 'tickets-summary' }, summaryLine(data)),
    h(
      'table',
      { class: 'taiga-projects-table tickets-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Ticket'), h('th', {}, 'Status'), h('th', {}, 'Hạn'), h('th', {}, 'Đóng lúc'), h('th', {}, 'Effort'), h('th', {}))),
      h('tbody', {}, ...report.tickets.flatMap((ticket) => ticketRows(ticket, data!))),
    ),
    ...notes.filter((note) => note !== false),
  );
  setBusy(busy);
}

function toggleComment(key: string): void {
  commentOpen = commentOpen === key ? undefined : key;
  render();
  if (commentOpen) document.querySelector<HTMLTextAreaElement>(`tr[data-comment="${CSS.escape(commentOpen)}"] textarea`)?.focus();
}

/** Reads the period's tickets; a newer read wins over an older one still running. */
async function load(next: Period = period): Promise<void> {
  period = next;
  loadedAs = context.loginKey();
  const mine = ++reading;
  data = undefined;
  readFailure = undefined;
  render();
  setBusy(true);
  const result = await context.api.readMyTickets(period.from, period.to);
  if (mine !== reading) return;
  setBusy(false);
  if (result.ok) data = result.value;
  else readFailure = result;
  render();
}

function choosePeriod(next: Period): void {
  writeResult = undefined;
  void load(next);
}

async function changeStatus(ticket: Ticket, to: StoryStatusEntry): Promise<void> {
  setBusy(true);
  const result = await context.api
    .setTicketStatus({ slug: ticket.project.slug, ref: ticket.ref, subject: ticket.subject, from: ticket.status, to: to.name, closes: to.isClosed })
    .finally(() => setBusy(false));
  if (result.ok && result.value.status === 'cancelled') {
    context.toast('Đã huỷ, chưa ghi gì lên Taiga.');
    return render();
  }
  if (result.ok && result.value.status === 'done') {
    const change = result.value.value;
    writeResult = h(
      'p',
      { class: 'ok' },
      change.changed ? `Đã đổi #${change.ticket.ref} ${change.ticket.subject}: ${change.from} → ${change.to}.` : `#${change.ticket.ref} đã ở status ${change.to}: không đổi gì.`,
    );
  } else if (!result.ok) {
    writeResult = context.failureBlock(result);
  }
  await load();
}

async function sendComment(ticket: Ticket, text: string): Promise<void> {
  if (busy) return;
  if (!text.trim()) return context.toast('Comment đang trống.', 'error');
  setBusy(true);
  const result = await context.api.commentTicket({ slug: ticket.project.slug, ref: ticket.ref, subject: ticket.subject, text }).finally(() => setBusy(false));
  if (result.ok && result.value.status === 'cancelled') return context.toast('Đã huỷ, chưa ghi gì lên Taiga.');
  if (result.ok && result.value.status === 'done') {
    drafts.delete(keyOf(ticket));
    commentOpen = undefined;
    writeResult = h('p', { class: 'ok' }, `Đã gửi comment lên #${ticket.ref} ${ticket.subject}.`);
  } else if (!result.ok) {
    writeResult = context.failureBlock(result);
  }
  await load();
}

/** Wires Taiga > Ticket của tôi; it reads when the section first shows, and again when the login changed since. */
export function mountMyTickets(ctx: MyTicketsContext): void {
  context = ctx;
  period = weekOf(new Date());
  byId('tickets-prev').addEventListener('click', () => choosePeriod(shiftWeek(-1)));
  byId('tickets-this-week').addEventListener('click', () => choosePeriod(weekOf(new Date())));
  byId('tickets-next').addEventListener('click', () => choosePeriod(shiftWeek(1)));
  byId('tickets-refresh').addEventListener('click', () => void load());
  for (const id of ['tickets-from', 'tickets-to']) {
    byId(id).addEventListener('change', () => {
      const from = byId<HTMLInputElement>('tickets-from').value;
      const to = byId<HTMLInputElement>('tickets-to').value;
      if (!from || !to) return;
      if (from > to) return context.toast('Ngày bắt đầu đang sau ngày kết thúc.', 'error');
      choosePeriod({ from, to });
    });
  }
  onSectionChange((section) => {
    if (section === 'taiga' && loadedAs !== context.loginKey()) void load();
  });
}

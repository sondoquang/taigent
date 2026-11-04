// Taiga > Ticket của tôi: the Period's tickets of the logged-in user (`taigent tickets --json`), by default this week
// Monday to Sunday, with due status and effort. A ticket's status changes from a dropdown (`taigent status`) and a
// comment goes from a text box (`taigent comment`); the main process confirms each write first, and the list is read
// again after every write, done or failed. It reads when the section first shows, and again when the login changed since.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { DueStatus, Failure, MyTickets, StoryStatusEntry, Ticket } from '../../../shared/api.ts';
import { toast } from '@/actions.ts';
import { StatusBadge, type Tone } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { api, useApp } from '@/store.ts';
import { cn } from '@/lib/utils.ts';

interface Period {
  from: string;
  to: string;
}

/** What is running: the list read, or a write on one ticket (`status:<key>`, `comment:<key>`). Controls wait for it. */
type Busy = 'read' | `status:${string}` | `comment:${string}` | undefined;

const DUE_LABELS: Record<DueStatus, string> = {
  'On time': 'Đúng hạn',
  Late: 'Trễ hạn',
  Overdue: 'Quá hạn',
  'On track': 'Còn hạn',
  'No due date': 'Không có hạn',
};

const DUE_TONES: Record<DueStatus, Tone> = {
  'On time': 'approved',
  Late: 'changes',
  Overdue: 'stale',
  'On track': 'new',
  'No due date': 'neutral',
};

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Monday to Sunday of the local week holding `day`. */
function weekOf(day: Date): Period {
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7));
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { from: dayOf(monday), to: dayOf(sunday) };
}

/** The week `weeks` before or after the one holding the period's first day. */
function shiftWeek(period: Period, weeks: number): Period {
  const [year, month, day] = period.from.split('-').map(Number);
  return weekOf(new Date(year!, month! - 1, day! + 7 * weeks));
}

const keyOf = (ticket: Ticket) => `${ticket.project.slug}#${ticket.ref}`;

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

/** The ticket's status: a dropdown of its project's statuses and a save button enabled once another one is chosen. */
function StatusCell({ ticket, result, busy, onChange }: { ticket: Ticket; result: MyTickets; busy: Busy; onChange(to: StoryStatusEntry): void }) {
  const [choice, setChoice] = useState(ticket.status);
  const known = result.statuses[ticket.project.slug];
  if (!known || 'message' in known) {
    return (
      <TableCell className="whitespace-normal">
        {ticket.status}
        <div className="text-xs text-muted-foreground">{known?.message ?? ''}</div>
      </TableCell>
    );
  }
  const statuses: StoryStatusEntry[] = known.statuses.some((status) => status.name === ticket.status)
    ? known.statuses
    : [{ name: ticket.status, isClosed: ticket.isClosed }, ...known.statuses];
  const off = choice === ticket.status;
  return (
    <TableCell className="ticket-status-cell">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          size="sm"
          className="ticket-status"
          aria-label={`Status của #${ticket.ref}`}
          value={choice}
          disabled={Boolean(busy)}
          onChange={(event) => setChoice(event.target.value)}
        >
          {statuses.map((status) => (
            <NativeSelectOption key={status.name} value={status.name}>
              {status.isClosed ? `${status.name} (đóng)` : status.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ticket-status-save"
          data-off={String(off)}
          disabled={Boolean(busy) || off}
          onClick={() => {
            const to = statuses.find((status) => status.name === choice);
            if (to) onChange(to);
          }}
        >
          {busy === `status:${keyOf(ticket)}` && <Spinner />}
          Đổi status
        </Button>
      </div>
    </TableCell>
  );
}

export function TicketsCard() {
  const section = useApp((s) => s.section);
  const login = useApp((s) => s.login);
  const loginKey = `${login?.loggedIn}:${login?.apiUrl}:${login?.username}`;
  const [period, setPeriod] = useState<Period>(() => weekOf(new Date()));
  /** The date inputs: they follow the period, and hold a choice that does not make one (start after end). */
  const [dates, setDates] = useState<Period>(period);
  const [data, setData] = useState<MyTickets>();
  const [readFailure, setReadFailure] = useState<Failure>();
  /** The outcome of the last write, shown above the list until the next action. */
  const [writeResult, setWriteResult] = useState<ReactNode>();
  const [busy, setBusy] = useState<Busy>();
  /** The ticket whose comment box is open (`slug#ref`), and the unsent text of every box. */
  const [commentOpen, setCommentOpen] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Who the CLI acted as at the last read (`whoami`); a change since makes the card read again when it shows. */
  const loadedAs = useRef<string | undefined>(undefined);
  const reading = useRef(0);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  /** Reads the period's tickets; a newer read wins over an older one still running. */
  async function load(next: Period = period): Promise<void> {
    setPeriod(next);
    setDates(next);
    loadedAs.current = loginKey;
    const mine = ++reading.current;
    setData(undefined);
    setReadFailure(undefined);
    setBusy('read');
    const result = await api.readMyTickets(next.from, next.to);
    if (mine !== reading.current) return;
    setBusy(undefined);
    if (result.ok) setData(result.value);
    else setReadFailure(result);
  }

  useEffect(() => {
    if (section === 'taiga' && loadedAs.current !== loginKey) void load();
  }, [section, loginKey]);

  useEffect(() => {
    if (commentOpen) commentRef.current?.focus();
  }, [commentOpen]);

  function choosePeriod(next: Period): void {
    setWriteResult(undefined);
    void load(next);
  }

  function chooseDates(next: Period): void {
    setDates(next);
    if (!next.from || !next.to) return;
    if (next.from > next.to) return toast('Ngày bắt đầu đang sau ngày kết thúc.', 'error');
    choosePeriod(next);
  }

  async function changeStatus(ticket: Ticket, to: StoryStatusEntry): Promise<void> {
    setBusy(`status:${keyOf(ticket)}`);
    const result = await api
      .setTicketStatus({ slug: ticket.project.slug, ref: ticket.ref, subject: ticket.subject, from: ticket.status, to: to.name, closes: to.isClosed })
      .finally(() => setBusy(undefined));
    if (result.ok && result.value.status === 'cancelled') return toast('Đã huỷ, chưa ghi gì lên Taiga.');
    if (result.ok && result.value.status === 'done') {
      const change = result.value.value;
      setWriteResult(
        <p className="ok text-success">
          {change.changed ? `Đã đổi #${change.ticket.ref} ${change.ticket.subject}: ${change.from} → ${change.to}.` : `#${change.ticket.ref} đã ở status ${change.to}: không đổi gì.`}
        </p>,
      );
    } else if (!result.ok) {
      setWriteResult(<FailureBlock failure={result} />);
    }
    await load();
  }

  async function sendComment(ticket: Ticket): Promise<void> {
    if (busy) return;
    const key = keyOf(ticket);
    const text = drafts[key] ?? '';
    if (!text.trim()) return toast('Comment đang trống.', 'error');
    setBusy(`comment:${key}`);
    const result = await api.commentTicket({ slug: ticket.project.slug, ref: ticket.ref, subject: ticket.subject, text }).finally(() => setBusy(undefined));
    if (result.ok && result.value.status === 'cancelled') return toast('Đã huỷ, chưa ghi gì lên Taiga.');
    if (result.ok && result.value.status === 'done') {
      setDrafts(({ [key]: _sent, ...rest }) => rest);
      setCommentOpen(undefined);
      setWriteResult(<p className="ok text-success">{`Đã gửi comment lên #${ticket.ref} ${ticket.subject}.`}</p>);
    } else if (!result.ok) {
      setWriteResult(<FailureBlock failure={result} />);
    }
    await load();
  }

  const toggleComment = (key: string) => setCommentOpen((open) => (open === key ? undefined : key));
  const disabled = Boolean(busy);
  const report = data?.report;
  const status = readFailure
    ? ''
    : !report
      ? 'Đang đọc ticket của bạn trên Taiga…'
      : `Ticket của ${report.user.username}, kỳ ${report.range.from} → ${report.range.to}: đóng trong kỳ, có hạn trong kỳ, và mọi ticket còn mở (so với hôm nay, ${report.today}).`;

  function ticketRows(ticket: Ticket, result: MyTickets): ReactNode {
    const key = keyOf(ticket);
    const due = ticket.dueStatus ?? 'unknown';
    return (
      <Fragment key={key}>
        <TableRow data-ticket={key} className={cn(ticket.isClosed && 'closed text-muted-foreground')}>
          <TableCell className="max-w-80 whitespace-normal">
            <strong className="font-semibold text-foreground">#{ticket.ref} </strong>
            <span className="break-words">{ticket.subject}</span>
            <div className="text-xs text-muted-foreground">{ticket.project.name}</div>
          </TableCell>
          <StatusCell ticket={ticket} result={result} busy={busy} onChange={(to) => void changeStatus(ticket, to)} />
          <TableCell className="whitespace-normal">
            {ticket.dueDate ?? '—'}{' '}
            <StatusBadge
              tone={ticket.dueStatus === null ? 'neutral' : DUE_TONES[ticket.dueStatus]}
              className={cn('due', `due-${due.toLowerCase().replaceAll(' ', '-')}`)}
            >
              {dueLabel(ticket)}
            </StatusBadge>
          </TableCell>
          <TableCell>{closedLabel(ticket)}</TableCell>
          <TableCell className="whitespace-normal">{effortLabel(ticket)}</TableCell>
          <TableCell className="text-right">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ticket-comment-open"
              aria-expanded={commentOpen === key}
              disabled={disabled}
              onClick={() => toggleComment(key)}
            >
              {commentOpen === key ? 'Đóng comment' : 'Comment…'}
            </Button>
          </TableCell>
        </TableRow>
        {commentOpen === key && (
          <TableRow className="ticket-comment-row" data-comment={key}>
            <TableCell colSpan={6} className="whitespace-normal">
              <div className="flex flex-col gap-2">
                <Textarea
                  ref={commentRef}
                  className="ticket-comment-text"
                  rows={3}
                  aria-label={`Comment cho #${ticket.ref}`}
                  placeholder="Tiến độ, câu hỏi, link… (gửi lên Taiga dưới tên bạn)"
                  value={drafts[key] ?? ''}
                  disabled={disabled}
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.ctrlKey) void sendComment(ticket);
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => toggleComment(key)}>
                    Đóng
                  </Button>
                  <Button type="button" size="sm" className="ticket-comment-send" disabled={disabled} onClick={() => void sendComment(ticket)}>
                    {busy === `comment:${key}` && <Spinner />}
                    Gửi comment
                  </Button>
                </div>
              </div>
            </TableCell>
          </TableRow>
        )}
      </Fragment>
    );
  }

  return (
    <Card id="taiga-tickets" className="taiga-tickets">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <CardTitle className="mr-auto">
          <h2>Ticket của tôi</h2>
        </CardTitle>
        <Button id="tickets-prev" type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => choosePeriod(shiftWeek(period, -1))}>
          ‹ Tuần trước
        </Button>
        <Button id="tickets-this-week" type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => choosePeriod(weekOf(new Date()))}>
          Tuần này
        </Button>
        <Button id="tickets-next" type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => choosePeriod(shiftWeek(period, 1))}>
          Tuần sau ›
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor="tickets-from">Từ</Label>
          <Input
            id="tickets-from"
            type="date"
            className="h-8 w-auto"
            value={dates.from}
            disabled={disabled}
            onChange={(event) => chooseDates({ ...dates, from: event.target.value })}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="tickets-to">đến</Label>
          <Input
            id="tickets-to"
            type="date"
            className="h-8 w-auto"
            value={dates.to}
            disabled={disabled}
            onChange={(event) => chooseDates({ ...dates, to: event.target.value })}
          />
        </div>
        <Button id="tickets-refresh" type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => void load()}>
          {busy === 'read' && <Spinner />}
          Làm mới
        </Button>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <p id="tickets-status" className="text-muted-foreground" aria-live="polite">
          {status}
        </p>
        <div id="tickets-result" aria-live="polite" className="empty:hidden">
          {writeResult}
        </div>
        <div id="tickets-list" className="flex min-w-0 flex-col gap-3" data-period={report ? `${report.range.from}..${report.range.to}` : undefined}>
          {readFailure ? (
            <FailureBlock failure={readFailure} />
          ) : (
            data &&
            report &&
            (report.tickets.length === 0 ? (
              <p className="text-muted-foreground">Không có ticket nào trong kỳ này.</p>
            ) : (
              <>
                <p id="tickets-summary">{summaryLine(data)}</p>
                <Table className="taiga-projects-table tickets-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticket</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Hạn</TableHead>
                      <TableHead>Đóng lúc</TableHead>
                      <TableHead>Effort</TableHead>
                      <TableHead>
                        <span className="sr-only">Comment</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>{report.tickets.map((ticket) => ticketRows(ticket, data))}</TableBody>
                </Table>
                {report.notes.missingEffort.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Chưa có effort (không có Spent Time, không có points): {report.notes.missingEffort.map((t) => `#${t.ref} (${t.project})`).join(', ')}.
                  </p>
                )}
                {report.notes.bulkCloses.map((run, index) => (
                  <p key={index} className="text-xs text-muted-foreground">
                    {run.count} ticket được đóng cùng lúc ({run.tickets.map((t) => `#${t.ref}`).join(', ')}): ngày đóng có thể muộn hơn ngày làm xong.
                  </p>
                ))}
              </>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

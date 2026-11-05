// The Backlog item detail: breadcrumb, head (type, key, badges, subject), the verdict bar and the item's actions, the
// description exactly as pushed to Taiga, an issue's classification, the children, tags and custom attributes, the
// review comments with the agent's replies, and the comment composer (one draft per item, Ctrl+Enter sends).

import { type Dispatch, Fragment, type FormEvent, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { PreviewEpic, PreviewIssue, PreviewItem, PreviewStory, VerdictChoice } from '../../../shared/api.ts';
import { applyView, select, toast } from '@/actions.ts';
import { Block, Code, formatTime, ReviewBadges, StatusBadge, TONE_CLASS, TypeBadge } from '@/components/common.tsx';
import { Markdown } from '@/components/markdown.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Empty, EmptyDescription } from '@/components/ui/empty.tsx';
import { Kbd } from '@/components/ui/kbd.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { cn } from '@/lib/utils.ts';
import { ItemActions } from '@/screens/backlog/forms/forms.tsx';
import { api, findNode, useApp } from '@/store.ts';

/** A child of the item (a story of an epic, a task of a story): its key and subject select it. */
function ItemLink({ item }: { item: PreviewItem }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Button variant="link" size="sm" className="link h-auto min-w-0 justify-start gap-2 px-0 py-0.5 whitespace-normal text-left" onClick={() => select(item.key)}>
        <Code>{item.key}</Code>
        <span className="min-w-0 break-words">{item.subject}</span>
      </Button>
      <ReviewBadges item={item} compact />
    </li>
  );
}

const VERDICT_BUTTONS: { verdict: VerdictChoice; label: string; hook: string }[] = [
  { verdict: 'approved', label: 'Đạt', hook: 'approve' },
  { verdict: 'changes', label: 'Cần sửa', hook: 'changes' },
  { verdict: 'clear', label: 'Bỏ đánh giá', hook: 'clear' },
];

function VerdictBar({ item }: { item: PreviewItem }) {
  const review = item.review;
  const [pending, setPending] = useState<VerdictChoice>();

  const setVerdict = async (verdict: VerdictChoice) => {
    const view = useApp.getState().view;
    if (!view) return;
    setPending(verdict);
    try {
      const result = await api.setVerdict(view.slug, item.key, verdict);
      if (!result.ok) return void toast(result.message, 'error');
      applyView(result);
      toast(verdict === 'clear' ? `Đã bỏ đánh giá ${item.key}` : `${item.key}: ${verdict === 'approved' ? 'Đạt' : 'Cần sửa'}`);
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="verdict-bar flex flex-wrap items-center gap-2">
      {VERDICT_BUTTONS.filter(({ verdict }) => verdict !== 'clear' || review.verdict).map(({ verdict, label, hook }) => {
        const on = review.verdict === verdict && !review.stale;
        return (
          <Button
            key={verdict}
            type="button"
            variant={verdict === 'clear' ? 'ghost' : 'outline'}
            size="sm"
            data-verdict={verdict}
            aria-pressed={verdict === 'clear' ? undefined : on}
            disabled={pending !== undefined}
            className={cn('verdict', hook, on && 'on', on && (verdict === 'approved' ? TONE_CLASS.approved : TONE_CLASS.changes))}
            onClick={() => void setVerdict(verdict)}
          >
            {pending === verdict && <Spinner aria-hidden="true" />}
            {label}
          </Button>
        );
      })}
      {review.verdict ? (
        <span className={cn('verdict-note text-xs', review.stale ? 'stale text-destructive' : 'text-muted-foreground')}>
          {`${review.verdict === 'approved' ? 'Đạt' : 'Cần sửa'} – ${review.by ?? '?'}, ${formatTime(review.at)}`}
          {review.stale && <strong> · Nội dung đã đổi sau khi duyệt, hãy xem lại.</strong>}
        </span>
      ) : (
        <span className="verdict-note text-xs text-muted-foreground">Chưa duyệt</span>
      )}
    </div>
  );
}

function Comments({ item }: { item: PreviewItem }) {
  const comments = item.review.comments;
  return (
    <Block title={`Góp ý (${comments.length}${item.review.openComments ? `, ${item.review.openComments} chưa xử lý` : ''})`}>
      {comments.length === 0 ? (
        <p className="text-muted-foreground">Chưa có góp ý.</p>
      ) : (
        <ol className="comments flex flex-col gap-2">
          {comments.map((comment) => (
            <li
              key={comment.id}
              className={cn('comment flex flex-col gap-2 rounded-lg border bg-card p-3', comment.resolved ? 'resolved' : 'open border-warning-border')}
            >
              <div className="comment-head flex flex-wrap items-center gap-2">
                <strong className="font-medium">{comment.by}</strong>
                <span className="text-xs text-muted-foreground">{formatTime(comment.at)}</span>
                <StatusBadge tone={comment.resolved ? 'approved' : 'changes'}>{comment.resolved ? 'Đã xử lý' : 'Chưa xử lý'}</StatusBadge>
              </div>
              <p className="comment-text whitespace-pre-wrap break-words">{comment.text}</p>
              {comment.reply && (
                <div className="reply flex flex-col gap-1 rounded-md border-l-2 border-info bg-muted px-3 py-2">
                  <span className="reply-label text-xs font-medium text-info">Agent trả lời</span>
                  <p className="whitespace-pre-wrap break-words">{comment.reply}</p>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}

function KeyValueTable({ className, rows }: { className?: string; rows: [string, string][] }) {
  return (
    <Table className={cn('attributes [--table-edge:0px]', className)}>
      <TableBody>
        {rows.map(([name, value]) => (
          <TableRow key={name}>
            <TableHead className="w-1/3">{name}</TableHead>
            <TableCell className="whitespace-normal break-words">{value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Drafts = Record<string, string>;

/** The composer under the detail: the draft of each item is kept while another item shows. */
function Composer({ itemKey, drafts, setDrafts }: { itemKey: string; drafts: Drafts; setDrafts: Dispatch<SetStateAction<Drafts>> }) {
  const [sending, setSending] = useState(false);
  const text = drafts[itemKey] ?? '';

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const view = useApp.getState().view;
    const key = itemKey;
    const comment = text.trim();
    if (!view || !comment || sending) return;
    setSending(true);
    try {
      const result = await api.addComment(view.slug, key, comment);
      if (!result.ok) return void toast(result.message, 'error');
      setDrafts(({ [key]: _sent, ...rest }) => rest);
      applyView(result);
      toast(`Đã thêm góp ý cho ${key}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <form id="composer" className="composer sticky bottom-0 flex flex-col gap-2 border-t bg-background px-6 py-3" onSubmit={(event) => void send(event)}>
      <Label htmlFor="comment-text">Góp ý cho mục này</Label>
      <Textarea
        id="comment-text"
        rows={3}
        className="min-h-16 resize-y"
        placeholder="Viết góp ý cho agent… (Ctrl+Enter để gửi)"
        value={text}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setDrafts((current) => ({ ...current, [itemKey]: value }));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-actions flex flex-wrap items-center justify-between gap-2">
        <span className="hint text-xs text-muted-foreground">
          <Kbd>j</Kbd>/<Kbd>k</Kbd> hoặc <Kbd>↑</Kbd>/<Kbd>↓</Kbd> để chuyển mục
        </span>
        <Button type="submit" size="sm" disabled={sending}>
          {sending && <Spinner aria-hidden="true" />}
          Gửi góp ý
        </Button>
      </div>
    </form>
  );
}

/** The right pane of the Backlog section; it scrolls back to the top when another item is selected. */
export function BacklogDetail() {
  const view = useApp((state) => state.view);
  const selected = useApp((state) => state.selected);
  const detailRef = useRef<HTMLElement>(null);
  // Per-item comment drafts; kept here, not in the composer, so they survive while no item (or project) shows.
  const [drafts, setDrafts] = useState<Drafts>({});
  const node = view && findNode(view, selected);

  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [selected]);

  if (!view || !node) {
    return (
      <section id="detail" ref={detailRef} className="detail flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
        <div id="detail-content" className="detail-content flex-1 p-6">
          <Empty className="empty">
            <EmptyDescription>
              {view ? (
                'Chọn một mục trong cây bên trái.'
              ) : (
                <>
                  Mở thư mục repo có <Code>taiga/&lt;slug&gt;/backlog.yaml</Code>, rồi chọn dự án.
                </>
              )}
            </EmptyDescription>
          </Empty>
        </div>
      </section>
    );
  }

  const item = node.item;
  const story = item.type === 'story' ? node.story : undefined;
  const epic = item.type === 'epic' ? node.epic : undefined;
  const trail = [node.epic, node.story].filter((parent): parent is PreviewEpic | PreviewStory => parent !== undefined && parent !== item);
  const attributes = Object.entries(item.customAttributes);
  const values = item.type === 'issue' ? (item as PreviewIssue).values : undefined;

  return (
    <section id="detail" ref={detailRef} className="detail flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <div id="detail-content" className="detail-content mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
        <Breadcrumb className="breadcrumb">
          <BreadcrumbList>
            {trail.map((parent) => (
              <Fragment key={parent.key}>
                <BreadcrumbItem className="min-w-0">
                  <BreadcrumbLink asChild>
                    <button type="button" className="link max-w-60 truncate" title={parent.subject} onClick={() => select(parent.key)}>
                      {parent.subject}
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </Fragment>
            ))}
            <BreadcrumbItem>
              <BreadcrumbPage className="text-xs">{item.key}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <header className="detail-head flex flex-col gap-3">
          <div className="detail-meta flex flex-wrap items-center gap-2">
            <TypeBadge type={item.type} />
            <Code>{item.key}</Code>
            <ReviewBadges item={item} compact={false} />
          </div>
          <h1 className="text-xl font-medium break-words">{item.subject}</h1>
          <VerdictBar item={item} />
          <ItemActions item={item} />
        </header>

        <Block title="Mô tả (đúng nội dung ghi lên Taiga)">
          <Markdown text={item.description} />
        </Block>

        {values && (
          <Block title="Phân loại">
            <KeyValueTable
              className="issue-values"
              rows={[
                ['Loại', values.type],
                ['Mức độ', values.severity],
                ['Ưu tiên', values.priority],
              ]}
            />
          </Block>
        )}

        {story && (
          <Block title={`Task (${story.tasks.length})`}>
            {story.tasks.length ? (
              <ul className="children flex flex-col gap-1">
                {story.tasks.map((task) => (
                  <ItemLink key={task.key} item={task} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">Không có task.</p>
            )}
          </Block>
        )}

        {epic && (
          <Block title={`Story (${epic.stories.length})`}>
            <ul className="children flex flex-col gap-1">
              {epic.stories.map((child) => (
                <ItemLink key={child.key} item={child} />
              ))}
            </ul>
          </Block>
        )}

        {(item.tags.length > 0 || attributes.length > 0) && (
          <Block title="Tag và thuộc tính">
            {item.tags.length > 0 && (
              <div className="tags flex flex-wrap gap-1">
                {item.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="tag">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            {attributes.length > 0 && <KeyValueTable rows={attributes.map(([name, value]) => [name, String(value)])} />}
          </Block>
        )}

        <Comments item={item} />
      </div>
      <Composer itemKey={item.key} drafts={drafts} setDrafts={setDrafts} />
    </section>
  );
}

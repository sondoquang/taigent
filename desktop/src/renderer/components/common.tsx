// Small pieces several screens share: item type and review badges, the stat cells of the Backlog summary and the
// Thay đổi overview, page headers and content blocks. Hook classes (`badge approved`, `stat`, `block`…) stay on the
// elements because the smoke scripts (scripts/smoke*.mjs) select them.

import type { ReactNode } from 'react';
import type { PreviewItem } from '../../shared/api.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { cn } from '@/lib/utils.ts';

export const TYPE_LABEL: Record<PreviewItem['type'], string> = { epic: 'Epic', story: 'Story', task: 'Task', issue: 'Issue' };

/** Review state of an item: its label and its tone (also its hook class). */
export type ReviewTone = 'approved' | 'changes' | 'stale' | 'unreviewed';

export function reviewStatus(item: PreviewItem): { label: string; tone: ReviewTone } {
  if (item.review.stale) return { label: 'Đã đổi sau khi duyệt', tone: 'stale' };
  if (item.review.verdict === 'approved') return { label: 'Đạt', tone: 'approved' };
  if (item.review.verdict === 'changes') return { label: 'Cần sửa', tone: 'changes' };
  return { label: 'Chưa duyệt', tone: 'unreviewed' };
}

/** Status tones as Medusa's tag colours: a tinted fill, a border and text of the same hue. */
export const TONE_CLASS = {
  approved: 'border-success-border bg-success-bg text-success',
  changes: 'border-warning-border bg-warning-bg text-warning',
  stale: 'border-danger-border bg-danger-bg text-danger',
  unreviewed: 'border-neutral-border bg-neutral-bg text-neutral',
  new: 'border-info-border bg-info-bg text-info',
  applied: 'border-neutral-border bg-neutral-bg text-neutral',
  comments: 'border-info-border bg-info-bg text-info',
  neutral: 'border-neutral-border bg-neutral-bg text-neutral',
} as const;
export type Tone = keyof typeof TONE_CLASS;

/** A status badge; `tone` is also its hook class (`.badge.approved`). */
export function StatusBadge({ tone, title, className, children }: { tone: Tone; title?: string; className?: string; children: ReactNode }) {
  return (
    <Badge variant="outline" title={title} className={cn('badge', tone, TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  );
}

export function TypeBadge({ type }: { type: PreviewItem['type'] }) {
  return (
    <Badge variant="secondary" className={cn('type', `type-${type}`, 'text-2xs uppercase tracking-wide')}>
      {TYPE_LABEL[type]}
    </Badge>
  );
}

/** Pushed or new, the review state, and the open comments of an item; `compact` shortens "Đã đổi sau khi duyệt". */
export function ReviewBadges({ item, compact }: { item: PreviewItem; compact: boolean }) {
  const status = reviewStatus(item);
  return (
    <span className="badges inline-flex flex-wrap items-center gap-1">
      {item.applied ? (
        <StatusBadge tone="applied" title={`Đã có trên Taiga (id ${item.applied.id})`}>
          Đã đẩy #{item.applied.ref}
        </StatusBadge>
      ) : (
        <StatusBadge tone="new">Mới</StatusBadge>
      )}
      <StatusBadge tone={status.tone}>{compact && status.tone === 'stale' ? 'Đã đổi' : status.label}</StatusBadge>
      {item.review.openComments > 0 && (
        <StatusBadge tone="comments" title="Góp ý chưa xử lý">
          {item.review.openComments} góp ý
        </StatusBadge>
      )}
    </span>
  );
}

const TONE_TEXT: Record<Tone, string> = {
  approved: 'text-success',
  changes: 'text-warning',
  stale: 'text-destructive',
  unreviewed: 'text-foreground',
  new: 'text-info',
  applied: 'text-foreground',
  comments: 'text-info',
  neutral: 'text-foreground',
};

/** One number with its label, as in the Backlog summary and the Thay đổi overview; `tone` is also its hook class. */
export function StatCell({ label, value, tone }: { label: string; value: number | string; tone?: Tone }) {
  return (
    <div className={cn('stat flex min-w-0 flex-col', tone)}>
      <strong className={cn('text-lg font-medium tabular-nums', tone ? TONE_TEXT[tone] : 'text-foreground')}>{value}</strong>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** The title row of a screen: heading, description and its actions. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head flex flex-wrap items-start justify-between gap-4">
      <div className="page-title min-w-0 max-w-3xl space-y-1">
        <h1 className="text-xl font-medium">{title}</h1>
        {description && <p className="text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="page-actions flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A titled block of content (h3 + body), as in the item detail. */
export function Block({ title, className, children }: { title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn('block space-y-2', className)}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** A date and time in Vietnamese format; the raw text when it does not parse. */
export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('vi-VN');
}

/** Inline code with the design system's mono chip. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('rounded-sm border border-neutral-border bg-neutral-bg px-1 text-xs text-foreground', className)}>{children}</code>;
}

/** Medusa's loading table: a header band and `rows` row bands, pulsing, divided like the table they stand for. */
export function TableSkeleton({ rows = 6, label = 'Đang tải…', className }: { rows?: number; label?: string; className?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('table-skeleton flex flex-col divide-y', className)}>
      {Array.from({ length: rows + 1 }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full rounded-none" />
      ))}
    </div>
  );
}

/** The scrolling body of a screen other than Backlog: centered, padded, its blocks spaced. */
export function ScreenBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="screen-body min-h-0 flex-1 overflow-auto">
      <div className={cn('mx-auto flex w-full max-w-6xl flex-col gap-6 p-6', className)}>{children}</div>
    </div>
  );
}

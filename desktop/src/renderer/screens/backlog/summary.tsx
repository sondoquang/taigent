// The Backlog summary of the open project: item counts, pushed or new, the review progress and its states, and whether
// the manifest validates (an invalid one opens its issues in the result dialog).

import { showResult } from '@/actions.ts';
import { StatCell, StatusBadge, TONE_CLASS } from '@/components/common.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { cn } from '@/lib/utils.ts';
import { useApp } from '@/store.ts';

const METER_SEGMENTS = [
  ['approved', 'bg-success'],
  ['changes', 'bg-warning'],
  ['stale', 'bg-destructive'],
  ['unreviewed', 'bg-muted'],
] as const;

export function BacklogSummary() {
  const view = useApp((state) => state.view);
  if (!view) return null;
  const s = view.preview.summary;
  // Review progress: one bar split by verdict, so how much of the backlog still needs a look reads at a glance.
  const reviewable = s.approved + s.changes + s.unreviewed + s.stale;
  return (
    <section id="summary" aria-label="Tổng quan" className="summary flex shrink-0 flex-wrap items-center gap-4 border-b bg-background px-4 py-3">
      <StatCell label="Epic" value={s.epics} />
      <StatCell label="Story" value={s.stories} />
      <StatCell label="Task" value={s.tasks} />
      <StatCell label="Issue" value={s.issues} />
      <Separator orientation="vertical" className="h-8" />
      <StatCell label="Mới" value={s.new} tone="new" />
      <StatCell label="Đã đẩy" value={s.applied} tone="applied" />
      <Separator orientation="vertical" className="h-8" />
      <div className="review-meter flex w-40 flex-col gap-1" role="img" aria-label={`${s.approved} trên ${reviewable} mục đạt`}>
        <span className="review-meter-label text-xs text-muted-foreground">
          <strong className="text-foreground">{s.approved}</strong> / {reviewable} đạt
        </span>
        <span className="review-meter-bar flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
          {METER_SEGMENTS.map(([tone, fill]) => s[tone] > 0 && <span key={tone} className={cn(`meter-${tone}`, fill)} style={{ flexGrow: s[tone] }} />)}
        </span>
      </div>
      <StatCell label="Đạt" value={s.approved} tone="approved" />
      <StatCell label="Cần sửa" value={s.changes} tone="changes" />
      <StatCell label="Chưa duyệt" value={s.unreviewed} tone="unreviewed" />
      <StatCell label="Đã đổi sau khi duyệt" value={s.stale} tone="stale" />
      <StatCell label="Góp ý mở" value={s.openComments} tone={s.openComments > 0 ? 'comments' : undefined} />
      <div className="flex-1" />
      {view.validation.valid ? (
        <StatusBadge tone="approved" className="validity ok">
          Manifest hợp lệ
        </StatusBadge>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className={cn('validity bad', TONE_CLASS.stale)}
          onClick={() =>
            showResult('Manifest chưa hợp lệ', { ok: false, message: view.validation.error ?? 'taigent validate báo lỗi', issues: view.validation.issues })
          }
        >
          Manifest lỗi ({view.validation.issues.length || 1}) – xem
        </Button>
      )}
      {s.unknownReviewKeys.length > 0 && (
        <StatusBadge tone="changes" className="validity warn" title={s.unknownReviewKeys.join(', ')}>
          {s.unknownReviewKeys.length} góp ý cho mục đã xoá
        </StatusBadge>
      )}
    </section>
  );
}

import { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown.ts';
import { cn } from '@/lib/utils.ts';

/**
 * Markdown rendered through marked + DOMPurify (lib/markdown.ts), styled by `.markdown` in globals.css. Empty text
 * shows `empty` (default "(không có mô tả)") instead.
 */
export function Markdown({ text, id, className, empty = '(không có mô tả)' }: { text: string; id?: string; className?: string; empty?: string | null }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  if (!text.trim() && empty !== null) {
    return (
      <div id={id} className={cn('markdown', className)}>
        <p className="text-muted-foreground">{empty}</p>
      </div>
    );
  }
  return <div id={id} className={cn('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

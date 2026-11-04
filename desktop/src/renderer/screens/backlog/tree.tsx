// The Backlog sidebar: the review filters, "+ Epic", and the tree (epics, their stories and tasks, then the Issues
// group). With a filter, a parent of a matching item stays as context; the selected row scrolls into view on every
// change and when the section shows again (a hidden tree cannot scroll).

import { useEffect, useRef } from 'react';
import { select, setFilter } from '@/actions.ts';
import { ReviewBadges, TypeBadge } from '@/components/common.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { cn } from '@/lib/utils.ts';
import { AddEpicButton, AddIssueButton } from '@/screens/backlog/forms/forms.tsx';
import { type Filter, matches, useApp, visibleNodes } from '@/store.ts';

const FILTERS: [Filter, string][] = [
  ['all', 'Tất cả'],
  ['unreviewed', 'Chưa duyệt'],
  ['changes', 'Cần sửa'],
  ['stale', 'Đã đổi'],
];

const DEPTH_INDENT = ['pl-2', 'pl-6', 'pl-12'];

function Filters() {
  const filter = useApp((state) => state.filter);
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      orientation="horizontal"
      aria-label="Lọc"
      className="filters w-full"
      value={filter}
      // A single toggle group deselects on a second click; the filter always has a value.
      onValueChange={(value) => value && setFilter(value as Filter)}
    >
      {FILTERS.map(([value, label]) => (
        <ToggleGroupItem key={value} value={value} data-filter={value} className={cn('filter flex-1', value === filter && 'active')}>
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Tree() {
  const view = useApp((state) => state.view);
  const filter = useApp((state) => state.filter);
  const selected = useApp((state) => state.selected);
  const shown = useApp((state) => state.section === 'backlog');
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (shown) selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [shown, view, filter, selected]);

  if (!view) return <nav id="tree" aria-label="Backlog" tabIndex={0} className="tree min-h-0 flex-1 overflow-y-auto" />;
  const nodes = visibleNodes(view, filter);
  // The Issues group follows the epic tree, with its "+ Issue" button even when the project has no issue yet.
  const group = (
    <div key="tree-group" className="tree-group mt-2 flex items-center justify-between gap-2 px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      <span>Issues ({view.preview.issues.length})</span>
      <AddIssueButton />
    </div>
  );
  const rows = nodes.map((node) => {
    const isSelected = node.item.key === selected;
    const context = !matches(node.item, filter);
    return (
      <button
        key={node.item.key}
        ref={isSelected ? selectedRef : undefined}
        type="button"
        data-key={node.item.key}
        aria-current={isSelected ? 'true' : undefined}
        className={cn(
          'node relative flex w-full min-w-0 items-center gap-2 rounded-md py-1 pr-2 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
          `depth-${node.depth}`,
          DEPTH_INDENT[node.depth],
          node.depth === 0 && 'mt-2 font-semibold',
          node.depth === 2 && 'text-muted-foreground',
          isSelected && 'selected bg-accent text-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary',
          context && 'context text-muted-foreground',
        )}
        onClick={() => select(node.item.key)}
      >
        <TypeBadge type={node.item.type} />
        <span className="subject min-w-0 flex-1 truncate" title={node.item.subject}>
          {node.item.subject}
        </span>
        <ReviewBadges item={node.item} compact />
      </button>
    );
  });
  const firstIssue = nodes.findIndex((node) => node.item.type === 'issue');
  rows.splice(firstIssue === -1 ? rows.length : firstIssue, 0, group);
  return (
    <nav
      id="tree"
      aria-label="Backlog"
      tabIndex={0}
      className="tree min-h-0 flex-1 overflow-y-auto px-2 pb-4 outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
    >
      {nodes.length === 0 ? (
        <>
          <p className="empty small p-4 text-center text-muted-foreground">{filter === 'all' ? 'Backlog chưa có mục nào.' : 'Không có mục nào khớp bộ lọc.'}</p>
          {group}
        </>
      ) : (
        rows
      )}
    </nav>
  );
}

/** The left pane of the Backlog section. */
export function BacklogSidebar() {
  return (
    <aside className="sidebar flex min-h-0 w-2/5 min-w-80 max-w-xl shrink-0 flex-col border-r bg-sidebar">
      <div className="flex flex-col gap-2 border-b p-3">
        <Filters />
        <AddEpicButton />
      </div>
      <Tree />
    </aside>
  );
}

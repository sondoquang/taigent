import { BookOpen, ChartColumnBig, CloudUpload, GitBranch, ListChecks, SlidersHorizontal, Wrench, type LucideIcon } from 'lucide-react';
import { showSection } from '@/actions.ts';
import { cn } from '@/lib/utils.ts';
import { type Section, useApp } from '@/store.ts';

const ITEMS: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'backlog', label: 'Backlog', icon: ListChecks },
  { section: 'wiki', label: 'Wiki', icon: BookOpen },
  { section: 'taiga', label: 'Taiga', icon: ChartColumnBig },
  { section: 'changes', label: 'Thay đổi', icon: CloudUpload },
  { section: 'git', label: 'Git', icon: GitBranch },
];
const FOOTER: typeof ITEMS = [
  { section: 'setup', label: 'Setup repo', icon: Wrench },
  { section: 'settings', label: 'Settings', icon: SlidersHorizontal },
];

function NavItem({ section, label, icon: Icon }: (typeof ITEMS)[number]) {
  const active = useApp((state) => state.section === section);
  return (
    <button
      type="button"
      data-section={section}
      aria-current={active ? 'page' : undefined}
      onClick={() => showSection(section)}
      className={cn(
        'nav-item flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-medium text-sidebar-foreground/80 outline-none transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/50',
        'active:bg-sidebar-accent/80',
        active && 'active bg-sidebar-accent text-sidebar-accent-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="nav-label truncate">{label}</span>
    </button>
  );
}

/** The section rail; switching only shows and hides screens (App). */
export function NavRail() {
  return (
    <nav id="nav" aria-label="Điều hướng" className="nav-rail flex w-44 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2">
      {ITEMS.map((item) => (
        <NavItem key={item.section} {...item} />
      ))}
      <div className="flex-1" />
      {FOOTER.map((item) => (
        <NavItem key={item.section} {...item} />
      ))}
    </nav>
  );
}

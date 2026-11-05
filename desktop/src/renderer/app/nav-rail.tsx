import { BookOpen, ChartColumnBig, CloudUpload, GitBranch, LayoutDashboard, ListChecks, LogIn, LogOut, SlidersHorizontal, Wrench, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { openLogin, showSection } from '@/actions.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';
import { type Section, useApp } from '@/store.ts';

const ITEMS: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
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

/** Medusa's 24px avatar square: a raised tile holding an initial or an icon. */
function Avatar({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card text-xs font-medium text-foreground shadow-borders-base">
      {children}
    </span>
  );
}

/** Medusa's dashed group separator. */
function Divider() {
  return (
    <div className="px-3" aria-hidden="true">
      <div className="divider-dashed w-full" />
    </div>
  );
}

function Brand() {
  return (
    <div className="brand grid h-7 grid-cols-[24px_1fr] items-center gap-x-3 rounded-md p-0.5 pe-2">
      <Avatar>
        <svg viewBox="0 0 20 20" aria-hidden="true" className="size-4">
          <path d="m5.5 10.5 3 3 6-7" className="fill-none stroke-foreground" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Avatar>
      <span className="brand-name truncate text-sm font-medium">Taigent</span>
    </div>
  );
}

function NavItem({ section, label, icon: Icon }: (typeof ITEMS)[number]) {
  const active = useApp((state) => state.section === section);
  return (
    <button
      type="button"
      data-section={section}
      aria-current={active ? 'page' : undefined}
      onClick={() => showSection(section)}
      className={cn(
        'nav-item flex h-7 w-full items-center gap-x-2 rounded-md py-0.5 pr-2 pl-0.5 text-left text-sm font-medium outline-none transition-[color,background-color,box-shadow]',
        'focus-visible:shadow-borders-focus',
        active ? 'active bg-card text-foreground shadow-elevation-card' : 'text-muted-foreground hover:bg-sidebar-accent',
      )}
    >
      <span className="flex size-6 shrink-0 items-center justify-center">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="nav-label truncate">{label}</span>
    </button>
  );
}

/** The Taiga account, as Medusa's user row at the foot of the sidebar: opens the login or logout dialog. */
function AccountRow() {
  const login = useApp((state) => state.login);
  const button = (
    <button
      type="button"
      id="login-btn"
      onClick={openLogin}
      className="grid h-7 w-full grid-cols-[24px_1fr_16px] items-center gap-x-3 rounded-md p-0.5 pe-2 text-left text-sm font-medium outline-none transition-[color,background-color,box-shadow] hover:bg-sidebar-accent focus-visible:shadow-borders-focus"
    >
      <Avatar>{login?.loggedIn ? (login.username ?? '?').slice(0, 1).toUpperCase() : <LogIn className="size-3.5" aria-hidden="true" />}</Avatar>
      <span className="truncate">{login?.loggedIn ? `${login.username} · Đăng xuất` : 'Đăng nhập'}</span>
      {login?.loggedIn && <LogOut className="size-4 text-muted-foreground" aria-hidden="true" />}
    </button>
  );
  const hint = login?.loggedIn ? `Đăng nhập ${login.apiUrl} (${login.source})` : login?.message;
  if (!hint) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** The full-height sidebar: the brand, the sections (switching only shows and hides screens, App), the account. */
export function NavRail() {
  return (
    <aside className="nav-rail flex w-55 shrink-0 flex-col border-r bg-sidebar">
      <div className="p-3">
        <Brand />
      </div>
      <Divider />
      <nav id="nav" aria-label="Điều hướng" className="flex min-h-0 flex-1 flex-col justify-between overflow-y-auto py-3">
        <div className="flex flex-col gap-y-3 px-3">
          {ITEMS.map((item) => (
            <NavItem key={item.section} {...item} />
          ))}
        </div>
        <div className="flex flex-col gap-y-3">
          <Divider />
          <div className="flex flex-col gap-y-3 px-3">
            {FOOTER.map((item) => (
              <NavItem key={item.section} {...item} />
            ))}
          </div>
        </div>
      </nav>
      <Divider />
      <div className="p-3">
        <AccountRow />
      </div>
    </aside>
  );
}

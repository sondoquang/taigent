// The terminal dock at the bottom of the window: hidden by default, toggled with the top-bar button
// (terminal-toggle.tsx) or Ctrl+`, resized by dragging its top edge. Each tab is an xterm.js terminal bound to one
// process in the main process (src/main/terminal.ts) through `api.terminal`; tabs opened by the main process (skill
// runs) show here too. The tab strip works like an editor's: an icon per kind of tab, × (or middle click) closes, the
// wheel scrolls it, a double click on its empty part opens the default shell, and + opens a searchable menu of this
// machine's shells and the agents. The terminal surface keeps the xterm theme's dark colours in both themes.
//
// The xterm.js instances live in a module-level Map, outside React: each is created once when its tab opens, opened
// into its tab's view node when that mounts, and disposed when the tab closes; renders never re-create them.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ChevronDown, Plus, Settings, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { TERMINAL_AGENTS, type TerminalAgent, type TerminalExit, type TerminalShell, type TerminalTab } from '../../../shared/api.ts';
import { showSection, toast } from '@/actions.ts';
import { Code } from '@/components/common.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';
import { type DockTab, setShown, useTerminal } from '@/screens/terminal/terminal-store.ts';
import { api } from '@/store.ts';

// xterm needs literal colours: the surface and text are the dark theme's surface.base/text tokens (globals.css).
const THEME = {
  background: '#000000',
  foreground: '#f4f4f5',
  cursor: '#f4f4f5',
  selectionBackground: '#3f3f46',
  black: '#18181b',
  red: '#f07178',
  green: '#a3d977',
  yellow: '#ffcb6b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#d0d4dc',
  brightBlack: '#8f8f8f',
  brightRed: '#ff8b92',
  brightGreen: '#c3e88d',
  brightYellow: '#ffe08a',
  brightBlue: '#a6c4ff',
  brightMagenta: '#ddb6f2',
  brightCyan: '#b2ebff',
  brightWhite: '#ffffff',
};
const MIN_HEIGHT = 120;

/** Stroke paths on a 24×24 grid for the kinds of tab (lucide has no glyph for these agents and shells). */
const GLYPHS = {
  powershell: ['M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'm7 9 3 3-3 3', 'M13 15h4'],
  prompt: ['m5 7 5 5-5 5', 'M12 17h7'],
  git: ['M12 2.5 21.5 12 12 21.5 2.5 12z', 'M12 8v8', 'm12 12 3-3'],
  claude: ['M12 3v18', 'M3 12h18', 'm5.6 5.6 12.8 12.8', 'M18.4 5.6 5.6 18.4'],
  codex: ['M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9z', 'm9 10 3 2-3 2', 'M13 15h3'],
  omp: ['M5 8h14', 'M9 8v10', 'M15 8v8a2 2 0 0 0 2 2'],
  skill: ['M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z', 'M18 15v4', 'M16 17h4'],
} satisfies Record<string, string[]>;
type GlyphName = keyof typeof GLYPHS;

const AGENT_LABELS: Record<TerminalAgent, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'OMP' };

function Glyph({ name, className }: { name: GlyphName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}
    >
      {GLYPHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function shellGlyph(shell: string | undefined): GlyphName {
  if (shell === 'cmd') return 'prompt';
  if (shell === 'git-bash') return 'git';
  return shell === 'default' ? 'prompt' : 'powershell';
}

// ---- the xterm.js instances ------------------------------------------------------------------------------------

interface Instance {
  term: Terminal;
  fit: FitAddon;
  /** The tab's view (`.terminal-view`), set when it mounts. */
  view?: HTMLDivElement;
}

const instances = new Map<number, Instance>();

function tabOf(id: number): DockTab | undefined {
  return useTerminal.getState().tabs.find((tab) => tab.info.id === id);
}

/** Fits the active terminal to its view and tells the process its new size. */
function fitActive(): void {
  const { active, shown } = useTerminal.getState();
  const instance = active === undefined ? undefined : instances.get(active);
  if (active === undefined || !instance?.view || !shown || !instance.fit.proposeDimensions()) return;
  instance.fit.fit();
  instance.view.dataset.cols = String(instance.term.cols);
  instance.view.dataset.rows = String(instance.term.rows);
  if (!tabOf(active)?.exit) api.terminal.resize(active, instance.term.cols, instance.term.rows);
}

/** Shows tab `id` (the dock's effect fits and focuses it); a click on the active tab refocuses its terminal. */
function activate(id: number): void {
  if (useTerminal.getState().active !== id) {
    useTerminal.setState({ active: id });
    return;
  }
  fitActive();
  instances.get(id)?.term.focus();
}

function addTab(info: TerminalTab): void {
  const term = new Terminal({
    theme: THEME,
    fontFamily: "'Geist Mono', 'Cascadia Mono', 'Cascadia Code', Consolas, 'SFMono-Regular', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Ctrl+` belongs to the dock toggle, not to the shell.
  term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === 'Backquote'));
  term.onData((data) => {
    if (!tabOf(info.id)?.exit) api.terminal.write(info.id, data);
  });
  instances.set(info.id, { term, fit });
  useTerminal.setState((state) => ({ tabs: [...state.tabs, { info }], active: info.id, shown: true }));
}

async function closeTab(id: number): Promise<void> {
  if (!instances.has(id)) return;
  await api.terminal.close(id);
  const instance = instances.get(id);
  if (!instance) return;
  instances.delete(id);
  instance.term.dispose();
  const tabs = useTerminal.getState().tabs.filter((tab) => tab.info.id !== id);
  useTerminal.setState({ tabs, active: tabs.at(-1)?.info.id });
}

function onExit(id: number, exit: TerminalExit): void {
  const tab = tabOf(id);
  const instance = instances.get(id);
  if (!tab || !instance) return;
  const reason = exit.cancelled
    ? tab.info.kind === 'skill'
      ? 'Đã huỷ lần chạy (đã kill cả cây process)'
      : 'Đã dừng'
    : `Đã kết thúc, mã thoát ${exit.exitCode}`;
  instance.term.write(`\r\n\x1b[2m[${reason}. Đóng tab bằng ×.]\x1b[0m\r\n`);
  useTerminal.setState((state) => ({ tabs: state.tabs.map((each) => (each.info.id === id ? { ...each, exit } : each)) }));
}

/** Opens a tab and shows its error (no repository open, shell missing) in a toast. */
async function openTab(kind: 'shell' | TerminalAgent, shell?: string): Promise<void> {
  const result = await api.terminal.open(kind, shell);
  if (!result.ok) toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
}

// ---- the + menu ------------------------------------------------------------------------------------------------

/** One entry of the + menu; `launch` and `shell` also go on the element (data-launch, data-shell). */
interface MenuEntry {
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Matched by the search box, with the label and the hint. */
  keywords: string;
  launch?: 'shell' | TerminalAgent;
  shell?: string;
  run(): void;
}

/** Lower case without Vietnamese diacritics, so "cai dat" finds "Cài đặt". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd').replaceAll('Đ', 'D').toLowerCase();
}

function menuGroups(shells: TerminalShell[]): MenuEntry[][] {
  return [
    shells.map((shell, index) => ({
      label: `Terminal: ${shell.label}`,
      hint: index === 0 ? 'mặc định' : undefined,
      icon: <Glyph name={shellGlyph(shell.id)} />,
      keywords: `shell terminal ${shell.id}`,
      launch: 'shell' as const,
      shell: shell.id,
      run: () => void openTab('shell', shell.id),
    })),
    TERMINAL_AGENTS.map((agent) => ({
      label: AGENT_LABELS[agent],
      hint: agent,
      icon: <Glyph name={agent} />,
      keywords: 'agent',
      launch: agent,
      run: () => void openTab(agent),
    })),
    [
      {
        label: 'Cài đặt agent…',
        hint: 'Setup repo',
        icon: <Settings aria-hidden="true" />,
        keywords: 'settings install',
        run: () => showSection('setup'),
      },
    ],
  ];
}

/** The + button and its menu: matching entries only, groups without a match left out; ↑/↓ move, Enter runs. */
function NewTabMenu() {
  const shells = useTerminal((state) => state.shells);
  const shown = useTerminal((state) => state.shown);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  /** Escape gives the focus back to the + button; any other close leaves it where it went. */
  const escaped = useRef(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const groups = useMemo(() => {
    const folded = fold(query.trim());
    return menuGroups(shells)
      .map((group) => group.filter((entry) => fold(`${entry.label} ${entry.hint ?? ''} ${entry.keywords}`).includes(folded)))
      .filter((group) => group.length > 0);
  }, [shells, query]);
  const entries = groups.flat();

  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [open]);
  useEffect(() => {
    if (open) items.current[highlighted]?.scrollIntoView({ block: 'nearest' });
  }, [open, highlighted]);

  const onOpenChange = (next: boolean) => {
    if (next) {
      setQuery('');
      setHighlighted(0);
      escaped.current = false;
    }
    setOpen(next);
  };
  const run = (entry: MenuEntry) => {
    setOpen(false);
    entry.run();
  };
  const move = (by: number) => {
    if (entries.length > 0) setHighlighted((highlighted + by + entries.length) % entries.length);
  };

  let at = 0;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              id="terminal-new"
              variant="ghost"
              size="icon-sm"
              aria-label="Mở tab mới"
              aria-haspopup="menu"
              aria-controls="terminal-menu"
              className="self-center aria-expanded:bg-accent aria-expanded:text-accent-foreground"
            >
              <Plus aria-hidden="true" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Mở tab mới: terminal hoặc agent</TooltipContent>
      </Tooltip>
      <PopoverContent
        id="terminal-menu"
        align="start"
        // No exit animation (important, over tw-animate-css's animate-out): the menu is gone as soon as an entry is
        // picked or Escape is pressed, which the terminal smoke steps check right away.
        className="terminal-menu flex max-h-(--radix-popover-content-available-height) w-72 flex-col p-0 data-[state=closed]:animate-none!"
        onEscapeKeyDown={() => {
          escaped.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (!escaped.current) event.preventDefault();
        }}
      >
        <div className="border-b p-2">
          <Input
            id="terminal-menu-search"
            className="terminal-menu-search h-8"
            placeholder="Tìm terminal, agent…"
            aria-label="Tìm loại tab"
            role="combobox"
            aria-controls="terminal-menu-items"
            aria-expanded="true"
            aria-activedescendant={entries.length > 0 ? `terminal-menu-item-${highlighted}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setHighlighted(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(event.key === 'ArrowDown' ? 1 : -1);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const chosen = entries[highlighted];
                if (chosen) run(chosen);
              }
            }}
          />
        </div>
        <div id="terminal-menu-items" role="menu" aria-label="Mở tab mới" className="terminal-menu-items min-h-0 overflow-y-auto">
          {groups.map((group, index) => (
            <div key={index} role="group" className={cn('terminal-menu-group flex flex-col p-1', index > 0 && 'border-t')}>
              {group.map((entry) => {
                const position = at++;
                const on = position === highlighted;
                return (
                  <button
                    key={entry.label}
                    ref={(node) => {
                      items.current[position] = node;
                    }}
                    type="button"
                    id={`terminal-menu-item-${position}`}
                    role="menuitem"
                    tabIndex={-1}
                    data-launch={entry.launch}
                    data-shell={entry.shell}
                    className={cn(
                      'terminal-menu-item flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                      on && 'highlighted bg-accent text-accent-foreground',
                    )}
                    onPointerMove={() => {
                      if (!on) setHighlighted(position);
                    }}
                    onClick={() => run(entry)}
                  >
                    {entry.icon}
                    <span className="terminal-menu-label min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.hint && <span className="terminal-menu-hint text-xs text-muted-foreground">{entry.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {entries.length === 0 && (
          <p id="terminal-menu-none" className="terminal-menu-none p-3 text-sm text-muted-foreground">
            Không có mục nào khớp.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---- the tab strip and the views ---------------------------------------------------------------------------

/** An icon-only button of a tab; its click never reaches the tab. */
function TabButton({ className, label, onClick, children }: { className: string; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className={className}
          aria-label={label}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const DOT_CLASS = {
  running: 'bg-foreground animate-pulse motion-reduce:animate-none',
  ok: 'bg-success',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
};

/** A skill run shows a running dot; an ended process shows how it ended (green 0, red other codes, grey cancelled). */
function StatusDot({ tab }: { tab: DockTab }) {
  const { exit } = tab;
  if (!exit && tab.info.kind !== 'skill') return null;
  const state = !exit ? 'running' : exit.cancelled ? 'cancelled' : exit.exitCode === 0 ? 'ok' : 'failed';
  const title = !exit ? 'Đang chạy' : exit.cancelled ? 'Đã dừng' : `Đã kết thúc, mã thoát ${exit.exitCode}`;
  return <span role="img" aria-label={title} title={title} data-state={state} className={cn('terminal-tab-status size-2 shrink-0 rounded-full', DOT_CLASS[state])} />;
}

function TabHeader({ tab, on }: { tab: DockTab; on: boolean }) {
  const { info, exit } = tab;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [on]);
  return (
    <div
      ref={ref}
      role="tab"
      id={`terminal-tab-${info.id}`}
      aria-selected={on}
      aria-controls={`terminal-view-${info.id}`}
      tabIndex={0}
      title={`${info.title} — ${info.cwd}`}
      data-id={info.id}
      data-pid={info.pid}
      data-kind={info.kind}
      data-shell={info.shell}
      data-exit-code={exit?.exitCode}
      data-cancelled={exit ? String(exit.cancelled) : undefined}
      className={cn(
        'terminal-tab group relative flex max-w-60 shrink-0 cursor-pointer items-center gap-2 border-r border-t-2 border-t-transparent pr-1 pl-3 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset',
        on && 'active border-t-primary bg-background text-foreground',
        exit && 'exited',
      )}
      onClick={() => activate(info.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        activate(info.id);
      }}
      // Middle click closes, as in an editor; mousedown would otherwise start autoscroll.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) void closeTab(info.id);
      }}
    >
      <span className={cn('terminal-tab-icon flex', exit && 'opacity-80')}>
        <Glyph name={info.kind === 'shell' ? shellGlyph(info.shell) : info.kind} className="size-3.5" />
      </span>
      <span className={cn('terminal-tab-title min-w-0 truncate', exit && 'opacity-80')}>{info.title}</span>
      <StatusDot tab={tab} />
      {info.kind === 'skill' && !exit && (
        <TabButton className="terminal-cancel" label="Huỷ lần chạy này (kill cả cây process)" onClick={() => void api.terminal.cancel(info.id)}>
          <Square aria-hidden="true" />
        </TabButton>
      )}
      {/* × shows on the active or hovered tab only, but stays clickable (and reachable by keyboard) everywhere. */}
      <TabButton
        className="terminal-close opacity-0 group-hover:opacity-100 group-[.active]:opacity-100 focus-visible:opacity-100"
        label={`Đóng tab ${info.title}`}
        onClick={() => void closeTab(info.id)}
      >
        <X aria-hidden="true" />
      </TabButton>
    </div>
  );
}

/** The tab's view: the xterm theme's dark surface, with the terminal opened into the inset node once. */
function TabView({ id, pid, on }: { id: number; pid: number; on: boolean }) {
  const view = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const instance = instances.get(id);
    if (!instance || !view.current || !host.current) return;
    instance.view = view.current;
    if (!instance.term.element) instance.term.open(host.current);
  }, [id]);
  return (
    <div
      ref={view}
      id={`terminal-view-${id}`}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${id}`}
      hidden={!on}
      data-id={id}
      data-pid={pid}
      className="terminal-view absolute inset-0"
      style={{ background: THEME.background }}
    >
      {/* FitAddon measures the node the terminal opens into, so the inset is a node of its own, not a padding. */}
      <div ref={host} className="absolute top-2 right-0 bottom-0 left-3" />
    </div>
  );
}

export function TerminalDock() {
  const shown = useTerminal((state) => state.shown);
  const tabs = useTerminal((state) => state.tabs);
  const active = useTerminal((state) => state.active);
  const dock = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const views = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const { terminal } = api;
    const unsubscribe = [
      terminal.onOpened(addTab),
      terminal.onData((id, data) => instances.get(id)?.term.write(data)),
      terminal.onExit(onExit),
    ];
    void terminal.shells().then((shells) => useTerminal.setState({ shells }));
    // Capture phase: the shortcut works while a terminal (or any field) has the focus.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.code === 'Backquote') || event.altKey || event.shiftKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setShown(!useTerminal.getState().shown);
    };
    document.addEventListener('keydown', onKeyDown, true);
    // The wheel scrolls the tab strip sideways; React's wheel listener is passive, so this one is native.
    const tabStrip = strip.current;
    const onWheel = (event: WheelEvent) => {
      if (!tabStrip || event.deltaY === 0 || event.deltaX !== 0) return;
      tabStrip.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    tabStrip?.addEventListener('wheel', onWheel, { passive: false });
    const observer = new ResizeObserver(() => fitActive());
    if (views.current) observer.observe(views.current);
    return () => {
      for (const off of unsubscribe) off();
      document.removeEventListener('keydown', onKeyDown, true);
      tabStrip?.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, []);

  // Showing the dock or another tab fits that tab's terminal and gives it the focus.
  useEffect(() => {
    if (!shown) return;
    fitActive();
    if (active !== undefined) instances.get(active)?.term.focus();
  }, [shown, active]);

  /** Drags the dock's top edge; the terminal refits through the ResizeObserver. */
  const startResize = (start: ReactPointerEvent<HTMLDivElement>) => {
    const node = dock.current;
    if (!node) return;
    start.preventDefault();
    const resizer = start.currentTarget;
    resizer.setPointerCapture(start.pointerId);
    setResizing(true);
    const bottom = node.getBoundingClientRect().bottom;
    const move = (event: PointerEvent) => {
      const height = Math.min(Math.max(bottom - event.clientY, MIN_HEIGHT), window.innerHeight - 160);
      node.style.setProperty('--terminal-height', `${Math.round(height)}px`);
    };
    const end = () => {
      setResizing(false);
      resizer.removeEventListener('pointermove', move);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', end, { once: true });
    resizer.addEventListener('pointercancel', end, { once: true });
  };

  return (
    <section
      ref={dock}
      id="terminal-dock"
      aria-label="Terminal"
      hidden={!shown}
      // --terminal-height is set inline by the resizer; the class keeps the default height.
      className="terminal-dock relative flex h-[var(--terminal-height,280px)] min-h-0 shrink-0 flex-col border-t bg-sidebar"
    >
      <div
        id="terminal-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Đổi cỡ terminal"
        title="Kéo để đổi cỡ"
        data-resizing={resizing || undefined}
        className="terminal-resizer absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize after:absolute after:inset-x-0 after:top-1 after:h-0.5 hover:after:bg-ring data-resizing:after:bg-ring"
        onPointerDown={startResize}
      />
      {/* Tab strip like an editor's: one tab per process, then + (the new-tab menu). */}
      <div
        ref={bar}
        id="terminal-bar"
        className="terminal-bar flex h-10 min-w-0 shrink-0 items-stretch pr-2 text-muted-foreground select-none"
        onDoubleClick={(event) => {
          const target = event.target;
          if (target === bar.current || target === strip.current || target === spacer.current) void openTab('shell');
        }}
      >
        <div ref={strip} id="terminal-tabs" role="tablist" aria-label="Tab terminal" className="terminal-tabs flex min-w-0 shrink overflow-x-auto [scrollbar-width:none]">
          {tabs.map((tab) => (
            <TabHeader key={tab.info.id} tab={tab} on={tab.info.id === active} />
          ))}
        </div>
        <NewTabMenu />
        <div ref={spacer} className="spacer flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button id="terminal-hide" variant="ghost" size="icon-sm" className="self-center" aria-label="Ẩn terminal" onClick={() => setShown(false)}>
              <ChevronDown aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ẩn terminal (Ctrl+`)</TooltipContent>
        </Tooltip>
      </div>
      <div ref={views} id="terminal-views" className="terminal-views relative min-h-0 flex-1 bg-background">
        {tabs.length === 0 && (
          <p id="terminal-empty" className="terminal-empty px-6 py-4 text-sm text-muted-foreground">
            Chưa có tab nào. Bấm <b className="font-medium text-foreground">+</b> trên thanh tab để mở terminal hoặc agent (<Code>claude</Code>,{' '}
            <Code>codex</Code>, <Code>omp</Code>), hoặc bấm đúp vào chỗ trống của thanh để mở shell mặc định. Tab chạy ở thư mục repo đang mở.
          </p>
        )}
        {tabs.map((tab) => (
          <TabView key={tab.info.id} id={tab.info.id} pid={tab.info.pid} on={tab.info.id === active} />
        ))}
      </div>
    </section>
  );
}

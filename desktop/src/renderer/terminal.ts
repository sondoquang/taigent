// The terminal panel at the bottom of the window: hidden by default, toggled with the top-bar button or Ctrl+`,
// resized by dragging its top edge. Each tab is an xterm.js terminal bound to one process in the main process
// (src/main/terminal.ts) through `window.taigent.terminal`; tabs opened by the main process (skill runs) show here too.
// The tab strip works like an editor's: an icon per kind of tab, × (or middle click) closes, the wheel scrolls it, a
// double click on its empty part opens the default shell, and + opens a searchable menu of this machine's shells and
// the agents.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_AGENTS, type TerminalAgent, type TerminalApi, type TerminalExit, type TerminalShell, type TerminalTab } from '../shared/api.ts';
import { showSection } from './navigation.ts';

interface Tab {
  info: TerminalTab;
  term: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  header: HTMLElement;
  exit?: TerminalExit;
}

/** One entry of the + menu; `launch` and `shell` also go on the element (data-launch, data-shell). */
interface MenuEntry {
  label: string;
  hint?: string;
  icon: IconName;
  /** Matched by the search box, with the label and the hint. */
  keywords: string;
  launch?: 'shell' | TerminalAgent;
  shell?: string;
  run(): void;
}

const THEME = {
  background: '#2b2b2b',
  foreground: '#ececec',
  cursor: '#ececec',
  selectionBackground: '#4d4d4d',
  black: '#2b2b2b',
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

/** Stroke paths on a 24×24 grid, drawn like the app's other icons (`.icon`). */
const ICONS = {
  powershell: ['M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'm7 9 3 3-3 3', 'M13 15h4'],
  prompt: ['m5 7 5 5-5 5', 'M12 17h7'],
  git: ['M12 2.5 21.5 12 12 21.5 2.5 12z', 'M12 8v8', 'm12 12 3-3'],
  claude: ['M12 3v18', 'M3 12h18', 'm5.6 5.6 12.8 12.8', 'M18.4 5.6 5.6 18.4'],
  codex: ['M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9z', 'm9 10 3 2-3 2', 'M13 15h3'],
  omp: ['M5 8h14', 'M9 8v10', 'M15 8v8a2 2 0 0 0 2 2'],
  skill: ['M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z', 'M18 15v4', 'M16 17h4'],
  settings: ['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'm4.9 4.9 2.1 2.1', 'm17 17 2.1 2.1', 'M4.9 19.1 7 17', 'm17 7 2.1-2.1'],
  close: ['M7 7l10 10', 'M17 7 7 17'],
  stop: ['M7 7h10v10H7z'],
} satisfies Record<string, string[]>;
type IconName = keyof typeof ICONS;

const AGENT_LABELS: Record<TerminalAgent, string> = { claude: 'Claude Code', codex: 'Codex', omp: 'OMP' };

const tabs = new Map<number, Tab>();
let active: number | undefined;
let shells: TerminalShell[] = [];
/** The + menu's entries now shown (after the search), and the one Enter runs. */
let shownEntries: { entry: MenuEntry; element: HTMLButtonElement }[] = [];
let highlighted = 0;

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing`);
  return found;
}

function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function shellIcon(shell: string | undefined): IconName {
  if (shell === 'cmd') return 'prompt';
  if (shell === 'git-bash') return 'git';
  return shell === 'default' ? 'prompt' : 'powershell';
}

function isShown(): boolean {
  return !el('terminal-dock').hidden;
}

/** Fits the active terminal to its view and tells the process its new size. */
function fitActive(api: TerminalApi): void {
  const tab = active === undefined ? undefined : tabs.get(active);
  if (!tab || !isShown() || !tab.fit.proposeDimensions()) return;
  tab.fit.fit();
  tab.view.dataset.cols = String(tab.term.cols);
  tab.view.dataset.rows = String(tab.term.rows);
  if (!tab.exit) api.resize(tab.info.id, tab.term.cols, tab.term.rows);
}

function setShown(api: TerminalApi, shown: boolean): void {
  if (!shown) closeMenu(false);
  el('terminal-dock').hidden = !shown;
  el('terminal-toggle').setAttribute('aria-expanded', String(shown));
  el('terminal-toggle').classList.toggle('active', shown);
  if (!shown) return;
  fitActive(api);
  if (active !== undefined) tabs.get(active)?.term.focus();
}

function activate(api: TerminalApi, id: number): void {
  active = id;
  for (const tab of tabs.values()) {
    const on = tab.info.id === id;
    tab.view.hidden = !on;
    tab.header.classList.toggle('active', on);
    tab.header.setAttribute('aria-selected', String(on));
  }
  el('terminal-empty').hidden = tabs.size > 0;
  tabs.get(id)?.header.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  fitActive(api);
  tabs.get(id)?.term.focus();
}

function iconButton(className: string, name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/** A skill run shows a running dot; an ended process shows how it ended (green 0, red other codes, grey cancelled). */
function statusDot(tab: Tab): HTMLElement | undefined {
  const { exit } = tab;
  if (!exit && tab.info.kind !== 'skill') return undefined;
  const dot = document.createElement('span');
  dot.className = 'terminal-tab-status';
  const state = !exit ? 'running' : exit.cancelled ? 'cancelled' : exit.exitCode === 0 ? 'ok' : 'failed';
  dot.dataset.state = state;
  dot.title = !exit ? 'Đang chạy' : exit.cancelled ? 'Đã dừng' : `Đã kết thúc, mã thoát ${exit.exitCode}`;
  return dot;
}

function renderHeader(api: TerminalApi, tab: Tab): void {
  const header = tab.header;
  header.replaceChildren();
  const glyph = document.createElement('span');
  glyph.className = 'terminal-tab-icon';
  glyph.append(icon(tab.info.kind === 'shell' ? shellIcon(tab.info.shell) : tab.info.kind));
  const title = document.createElement('span');
  title.className = 'terminal-tab-title';
  title.textContent = tab.info.title;
  header.title = `${tab.info.title} — ${tab.info.cwd}`;
  header.append(glyph, title);
  const dot = statusDot(tab);
  if (dot) header.append(dot);
  if (tab.info.kind === 'skill' && !tab.exit) {
    header.append(iconButton('terminal-cancel', 'stop', 'Huỷ lần chạy này (kill cả cây process)', () => void api.cancel(tab.info.id)));
  }
  const close = iconButton('terminal-close', 'close', 'Đóng tab (kill cả cây process)', () => void closeTab(api, tab.info.id));
  close.setAttribute('aria-label', `Đóng tab ${tab.info.title}`);
  header.append(close);
}

function addTab(api: TerminalApi, info: TerminalTab): void {
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
  const view = document.createElement('div');
  view.className = 'terminal-view';
  view.dataset.id = String(info.id);
  view.dataset.pid = String(info.pid);
  view.setAttribute('role', 'tabpanel');
  const header = document.createElement('div');
  header.className = 'terminal-tab';
  header.dataset.id = String(info.id);
  header.dataset.pid = String(info.pid);
  header.dataset.kind = info.kind;
  if (info.shell) header.dataset.shell = info.shell;
  header.setAttribute('role', 'tab');
  header.addEventListener('click', () => activate(api, info.id));
  // Middle click closes, as in an editor; mousedown would otherwise start autoscroll.
  header.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  header.addEventListener('auxclick', (event) => {
    if (event.button === 1) void closeTab(api, info.id);
  });
  const tab: Tab = { info, term, fit, view, header };
  tabs.set(info.id, tab);
  renderHeader(api, tab);
  el('terminal-tabs').append(header);
  el('terminal-views').append(view);
  term.open(view);
  // Ctrl+` belongs to the panel toggle, not to the shell.
  term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.code === 'Backquote'));
  term.onData((data) => {
    if (!tab.exit) api.write(info.id, data);
  });
  setShown(api, true);
  activate(api, info.id);
}

async function closeTab(api: TerminalApi, id: number): Promise<void> {
  const tab = tabs.get(id);
  if (!tab) return;
  await api.close(id);
  tabs.delete(id);
  tab.term.dispose();
  tab.view.remove();
  tab.header.remove();
  const next = [...tabs.keys()].at(-1);
  if (next !== undefined) activate(api, next);
  else {
    active = undefined;
    el('terminal-empty').hidden = false;
  }
}

function onExit(api: TerminalApi, id: number, exit: TerminalExit): void {
  const tab = tabs.get(id);
  if (!tab) return;
  tab.exit = exit;
  tab.header.classList.add('exited');
  tab.header.dataset.exitCode = String(exit.exitCode);
  tab.header.dataset.cancelled = String(exit.cancelled);
  const reason = exit.cancelled
    ? tab.info.kind === 'skill'
      ? 'Đã huỷ lần chạy (đã kill cả cây process)'
      : 'Đã dừng'
    : `Đã kết thúc, mã thoát ${exit.exitCode}`;
  tab.term.write(`\r\n\x1b[2m[${reason}. Đóng tab bằng ×.]\x1b[0m\r\n`);
  renderHeader(api, tab);
}

/** Opens a tab and shows its error (no repository open, shell missing) in a toast. */
async function open(api: TerminalApi, kind: 'shell' | TerminalAgent, toast: (message: string) => void, shell?: string): Promise<void> {
  const result = await api.open(kind, shell);
  if (!result.ok) toast([result.message, result.detail].filter(Boolean).join(': '));
}

// ---- the + menu ------------------------------------------------------------------------------------------------

/** Lower case without Vietnamese diacritics, so "cai dat" finds "Cài đặt". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replaceAll('đ', 'd').replaceAll('Đ', 'D').toLowerCase();
}

function menuGroups(api: TerminalApi, toast: (message: string) => void): MenuEntry[][] {
  return [
    shells.map((shell, index) => ({
      label: `Terminal: ${shell.label}`,
      hint: index === 0 ? 'mặc định' : undefined,
      icon: shellIcon(shell.id),
      keywords: `shell terminal ${shell.id}`,
      launch: 'shell' as const,
      shell: shell.id,
      run: () => void open(api, 'shell', toast, shell.id),
    })),
    TERMINAL_AGENTS.map((agent) => ({
      label: AGENT_LABELS[agent],
      hint: agent,
      icon: agent,
      keywords: 'agent',
      launch: agent,
      run: () => void open(api, agent, toast),
    })),
    [
      {
        label: 'Cài đặt agent…',
        hint: 'Setup repo',
        icon: 'settings' as const,
        keywords: 'settings install',
        run: () => showSection('setup'),
      },
    ],
  ];
}

function isMenuOpen(): boolean {
  return !el('terminal-menu').hidden;
}

function highlight(index: number): void {
  if (shownEntries.length === 0) {
    el('terminal-menu-search').removeAttribute('aria-activedescendant');
    return;
  }
  highlighted = (index + shownEntries.length) % shownEntries.length;
  shownEntries.forEach(({ element }, at) => element.classList.toggle('highlighted', at === highlighted));
  const current = shownEntries[highlighted]?.element;
  if (!current) return;
  el('terminal-menu-search').setAttribute('aria-activedescendant', current.id);
  current.scrollIntoView({ block: 'nearest' });
}

/** Builds the menu for the search text: matching entries only, groups without a match left out. */
function renderMenu(api: TerminalApi, toast: (message: string) => void): void {
  const query = fold((el('terminal-menu-search') as HTMLInputElement).value.trim());
  const items = el('terminal-menu-items');
  items.replaceChildren();
  shownEntries = [];
  for (const group of menuGroups(api, toast)) {
    const matching = group.filter((entry) => fold(`${entry.label} ${entry.hint ?? ''} ${entry.keywords}`).includes(query));
    if (matching.length === 0) continue;
    const box = document.createElement('div');
    box.className = 'terminal-menu-group';
    box.setAttribute('role', 'group');
    for (const entry of matching) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = `terminal-menu-item-${shownEntries.length}`;
      button.className = 'terminal-menu-item';
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      if (entry.launch) button.dataset.launch = entry.launch;
      if (entry.shell) button.dataset.shell = entry.shell;
      const label = document.createElement('span');
      label.className = 'terminal-menu-label';
      label.textContent = entry.label;
      button.append(icon(entry.icon), label);
      if (entry.hint) {
        const hint = document.createElement('span');
        hint.className = 'terminal-menu-hint';
        hint.textContent = entry.hint;
        button.append(hint);
      }
      const at = shownEntries.length;
      button.addEventListener('pointermove', () => {
        if (highlighted !== at) highlight(at);
      });
      button.addEventListener('click', () => runEntry(entry));
      box.append(button);
      shownEntries.push({ entry, element: button });
    }
    items.append(box);
  }
  el('terminal-menu-none').hidden = shownEntries.length > 0;
  highlight(0);
}

function runEntry(entry: MenuEntry): void {
  closeMenu(false);
  entry.run();
}

/** Below the + button when it fits, else above it (the panel sits at the bottom of the window). */
function placeMenu(): void {
  const menu = el('terminal-menu');
  const anchor = el('terminal-new').getBoundingClientRect();
  const margin = 8;
  const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - margin));
  const below = window.innerHeight - anchor.bottom - margin;
  const top = menu.offsetHeight <= below || below >= anchor.top ? anchor.bottom + 4 : Math.max(margin, anchor.top - menu.offsetHeight - 4);
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openMenu(api: TerminalApi, toast: (message: string) => void): void {
  const search = el('terminal-menu-search') as HTMLInputElement;
  search.value = '';
  el('terminal-menu').hidden = false;
  el('terminal-new').setAttribute('aria-expanded', 'true');
  renderMenu(api, toast);
  placeMenu();
  search.focus();
}

/** Closes the menu; `refocus` gives the focus back to the + button (Escape), else it stays where it went. */
function closeMenu(refocus: boolean): void {
  if (!isMenuOpen()) return;
  el('terminal-menu').hidden = true;
  el('terminal-new').setAttribute('aria-expanded', 'false');
  if (refocus) el('terminal-new').focus();
}

function wireMenu(api: TerminalApi, toast: (message: string) => void): void {
  const search = el('terminal-menu-search') as HTMLInputElement;
  el('terminal-new').addEventListener('click', () => (isMenuOpen() ? closeMenu(false) : openMenu(api, toast)));
  search.addEventListener('input', () => {
    renderMenu(api, toast);
    placeMenu();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      highlight(highlighted + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = shownEntries[highlighted];
      if (chosen) runEntry(chosen.entry);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  });
  // A press outside the menu and its button closes it, without taking that press away from its target.
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as Node;
      if (isMenuOpen() && !el('terminal-menu').contains(target) && !el('terminal-new').contains(target)) closeMenu(false);
    },
    true,
  );
  window.addEventListener('resize', () => closeMenu(false));
  window.addEventListener('blur', () => closeMenu(false));
}

/** The wheel scrolls the tab strip sideways; a double click on its empty part opens the default shell. */
function wireStrip(api: TerminalApi, toast: (message: string) => void): void {
  const strip = el('terminal-tabs');
  strip.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY === 0 || event.deltaX !== 0) return;
      strip.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false },
  );
  const bar = el('terminal-bar');
  bar.addEventListener('dblclick', (event) => {
    const target = event.target as HTMLElement;
    if (target === bar || target === strip || target.classList.contains('spacer')) void open(api, 'shell', toast);
  });
}

/** Drags the panel's top edge; the terminal refits through the ResizeObserver. */
function wireResizer(): void {
  const dock = el('terminal-dock');
  const resizer = el('terminal-resizer');
  resizer.addEventListener('pointerdown', (start) => {
    start.preventDefault();
    resizer.setPointerCapture(start.pointerId);
    dock.classList.add('resizing');
    const bottom = dock.getBoundingClientRect().bottom;
    const move = (event: PointerEvent): void => {
      const height = Math.min(Math.max(bottom - event.clientY, MIN_HEIGHT), window.innerHeight - 160);
      dock.style.setProperty('--terminal-height', `${Math.round(height)}px`);
    };
    const end = (): void => {
      dock.classList.remove('resizing');
      resizer.removeEventListener('pointermove', move);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', end, { once: true });
    resizer.addEventListener('pointercancel', end, { once: true });
  });
}

export function wireTerminal(api: TerminalApi, toast: (message: string) => void): void {
  api.onOpened((info) => addTab(api, info));
  api.onData((id, data) => tabs.get(id)?.term.write(data));
  api.onExit((id, exit) => onExit(api, id, exit));
  void api.shells().then((found) => {
    shells = found;
    if (isMenuOpen()) renderMenu(api, toast);
  });
  el('terminal-toggle').addEventListener('click', () => setShown(api, !isShown()));
  el('terminal-hide').addEventListener('click', () => setShown(api, false));
  wireMenu(api, toast);
  wireStrip(api, toast);
  // Capture phase: the shortcut works while a terminal (or any field) has the focus.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey && event.code === 'Backquote') || event.altKey || event.shiftKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      setShown(api, !isShown());
    },
    true,
  );
  wireResizer();
  new ResizeObserver(() => fitActive(api)).observe(el('terminal-views'));
}

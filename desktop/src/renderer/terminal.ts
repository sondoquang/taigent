// The terminal panel at the bottom of the window: hidden by default, toggled with the top-bar button or Ctrl+`,
// resized by dragging its top edge. Each tab is an xterm.js terminal bound to one process in the main process
// (src/main/terminal.ts) through `window.taigent.terminal`; tabs opened by the main process (skill runs) show here too.

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { TerminalApi, TerminalExit, TerminalTab } from '../shared/api.ts';

interface Tab {
  info: TerminalTab;
  term: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  header: HTMLElement;
  exit?: TerminalExit;
}

const THEME = {
  background: '#1d2330',
  foreground: '#e6e9ef',
  cursor: '#e6e9ef',
  selectionBackground: '#3a4560',
  black: '#1d2330',
  red: '#f07178',
  green: '#a3d977',
  yellow: '#ffcb6b',
  blue: '#82aaff',
  magenta: '#c792ea',
  cyan: '#89ddff',
  white: '#d0d4dc',
  brightBlack: '#6b7280',
  brightRed: '#ff8b92',
  brightGreen: '#c3e88d',
  brightYellow: '#ffe08a',
  brightBlue: '#a6c4ff',
  brightMagenta: '#ddb6f2',
  brightCyan: '#b2ebff',
  brightWhite: '#ffffff',
};
const MIN_HEIGHT = 120;

const tabs = new Map<number, Tab>();
let active: number | undefined;

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing`);
  return found;
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
  fitActive(api);
  tabs.get(id)?.term.focus();
}

function renderHeader(api: TerminalApi, tab: Tab): void {
  const header = tab.header;
  header.replaceChildren();
  const title = document.createElement('span');
  title.className = 'terminal-tab-title';
  title.textContent = tab.info.title;
  header.title = `${tab.info.title} — ${tab.info.cwd}`;
  header.append(title);
  if (tab.info.kind === 'skill' && !tab.exit) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'terminal-cancel';
    cancel.textContent = 'Huỷ';
    cancel.title = 'Dừng lần chạy này (kill cả cây process)';
    cancel.addEventListener('click', (event) => {
      event.stopPropagation();
      void api.cancel(tab.info.id);
    });
    header.append(cancel);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'terminal-close';
  close.textContent = '×';
  close.title = 'Đóng tab (kill cả cây process)';
  close.setAttribute('aria-label', `Đóng tab ${tab.info.title}`);
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    void closeTab(api, tab.info.id);
  });
  header.append(close);
}

function addTab(api: TerminalApi, info: TerminalTab): void {
  const term = new Terminal({
    theme: THEME,
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'SFMono-Regular', Menlo, monospace",
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
  header.setAttribute('role', 'tab');
  header.addEventListener('click', () => activate(api, info.id));
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
async function open(api: TerminalApi, kind: 'shell' | 'claude' | 'codex' | 'omp', toast: (message: string) => void): Promise<void> {
  const result = await api.open(kind);
  if (!result.ok) toast([result.message, result.detail].filter(Boolean).join(': '));
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
  el('terminal-toggle').addEventListener('click', () => setShown(api, !isShown()));
  el('terminal-hide').addEventListener('click', () => setShown(api, false));
  el('terminal-new').addEventListener('click', () => void open(api, 'shell', toast));
  for (const button of document.querySelectorAll<HTMLButtonElement>('#terminal-dock [data-launch]')) {
    const agent = button.dataset.launch;
    if (agent === 'claude' || agent === 'codex' || agent === 'omp') button.addEventListener('click', () => void open(api, agent, toast));
  }
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

// The embedded terminal's main side: one node-pty process per tab, its output forwarded to the renderer (xterm.js)
// and its input taken from it, both over the typed channels of src/shared/api.ts. The renderer can only open a shell
// or an agent (claude, codex, omp) in the open repository; a tab that runs a given command (kind `skill`) is opened
// from the main process only, through `terminals.open`. Closing or cancelling a tab kills its whole process tree, and
// quitting the app kills every tree (`terminals.killAll`).

import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, join } from 'node:path';
import { app, type BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type * as NodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { CHANNELS, type Result, type TerminalAgent, type TerminalExit, type TerminalTab, TERMINAL_AGENTS } from '../shared/api.ts';
import { toFailure } from './project.ts';

/** A command run directly in the pty, without a shell. */
export interface TerminalCommand {
  file: string;
  args: string[];
  /** Added to the app's environment. */
  env?: Record<string, string>;
}

export type TerminalSpec =
  | { kind: 'shell' | TerminalAgent; cwd: string }
  | { kind: 'skill'; cwd: string; title: string; command: TerminalCommand };

export interface TerminalHandle {
  readonly tab: TerminalTab;
  /** Settles once the process has exited, by itself or killed. */
  readonly exited: Promise<TerminalExit>;
  /** Kills the process tree; the tab stays open and shows that it was cancelled. */
  cancel(): Promise<void>;
  /** Every chunk of output, as the renderer gets it; returns the unsubscribe function. */
  onData(listener: (data: string) => void): () => void;
}

interface Session {
  tab: TerminalTab;
  pty: IPty;
  exit?: TerminalExit;
  cancelled: boolean;
  pending: string;
  flushing: boolean;
  listeners: Set<(data: string) => void>;
  exited: Promise<TerminalExit>;
}

// node-pty is a native module: in the packaged app it lives unpacked next to app.asar (electron-builder asarUnpack),
// so it is loaded from there by path; its conout worker and console-list helper are then real files too.
const loadPty = (): typeof NodePty =>
  createRequire(import.meta.url)(
    app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty') : 'node-pty',
  ) as typeof NodePty;

const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/** `pwsh` on PATH, else Windows PowerShell; `$SHELL` elsewhere. */
function resolveShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'pwsh.exe'))) return join(dir, 'pwsh.exe');
  }
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * The shell's arguments: interactive, and with `command` (an agent, an install command) that command run first, then
 * the shell stays open (so a missing agent shows the shell's own error). PowerShell switches its console to UTF-8
 * first, so native programs' output (git, the agents) shows Vietnamese correctly.
 */
function shellArgs(shell: string, command: string | undefined): string[] {
  if (process.platform === 'win32') {
    const utf8 = '[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()';
    return ['-NoLogo', '-NoExit', '-Command', command ? `${utf8}; ${command}` : utf8];
  }
  return command ? ['-l', '-i', '-c', `${command}; exec "$0" -l`, shell] : ['-l'];
}

/** For a `skill` tab: the shell runs `command`, then stays open for the user. */
export function shellRun(command: string): TerminalCommand {
  const shell = resolveShell();
  return { file: shell, args: shellArgs(shell, command) };
}

/** Kills `pid` and every process under it. */
export function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    killGroup(pid);
    return Promise.resolve();
  }
  return new Promise((resolve) => execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

function killTreeSync(pid: number): void {
  if (process.platform === 'win32') spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
  else killGroup(pid);
}

/** node-pty starts the child in its own session, so its pid is the process group. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Where the main process sends tab events: the app window. */
export interface TerminalSink {
  opened(tab: TerminalTab): void;
  data(id: number, data: string): void;
  exit(id: number, exit: TerminalExit): void;
}

export class TerminalManager {
  private readonly sessions = new Map<number, Session>();
  private nextId = 1;
  private sink: TerminalSink | undefined;

  attach(sink: TerminalSink): void {
    this.sink = sink;
  }

  /** Opens a tab; the renderer shows the terminal panel and selects the tab. */
  open(spec: TerminalSpec): TerminalHandle {
    const agent = spec.kind === 'shell' || spec.kind === 'skill' ? undefined : spec.kind;
    const shell = spec.kind === 'skill' ? undefined : resolveShell();
    const file = spec.kind === 'skill' ? spec.command.file : shell!;
    const args = spec.kind === 'skill' ? spec.command.args : shellArgs(shell!, agent);
    const env: Record<string, string | undefined> = { ...process.env, COLORTERM: 'truecolor' };
    if (process.platform !== 'win32') env.TERM = 'xterm-256color';
    if (spec.kind === 'skill') Object.assign(env, spec.command.env);
    const pty = loadPty().spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: spec.cwd, env });
    const id = this.nextId++;
    const title = spec.kind === 'skill' ? spec.title : (agent ?? basename(shell!).replace(/\.exe$/i, ''));
    const tab: TerminalTab = { id, kind: spec.kind, title, cwd: spec.cwd, pid: pty.pid };
    const exited = Promise.withResolvers<TerminalExit>();
    const session: Session = { tab, pty, cancelled: false, pending: '', flushing: false, listeners: new Set(), exited: exited.promise };
    this.sessions.set(id, session);
    this.sink?.opened(tab);
    pty.onData((data) => {
      for (const listener of session.listeners) listener(data);
      this.queue(session, data);
    });
    pty.onExit(({ exitCode, signal }) => {
      this.flush(session);
      session.exit = { exitCode, signal, cancelled: session.cancelled };
      this.sink?.exit(id, session.exit);
      exited.resolve(session.exit);
    });
    return {
      tab,
      exited: session.exited,
      cancel: () => this.cancel(id),
      onData(listener) {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
    };
  }

  write(id: number, data: string): void {
    const session = this.sessions.get(id);
    if (session && !session.exit) session.pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || session.exit || !(cols >= 1 && rows >= 1)) return;
    try {
      session.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // The process exited between the check and the resize.
    }
  }

  /** Kills the tab's process tree and waits until it has exited; the tab stays. */
  async cancel(id: number): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.exit) return;
    session.cancelled = true;
    await killTree(session.pty.pid);
    this.killPty(session);
    await session.exited;
  }

  /** Kills the tab's process tree and forgets the tab. */
  async close(id: number): Promise<void> {
    await this.cancel(id);
    this.sessions.delete(id);
  }

  /** On quit: kills every process tree before the app exits. */
  killAll(): void {
    for (const session of this.sessions.values()) {
      if (session.exit) continue;
      session.cancelled = true;
      killTreeSync(session.pty.pid);
      this.killPty(session);
    }
    this.sessions.clear();
  }

  private killPty(session: Session): void {
    try {
      session.pty.kill();
    } catch {
      // Already exited.
    }
  }

  /** Output is batched per tick, so a chatty process does not send one IPC message per chunk. */
  private queue(session: Session, data: string): void {
    session.pending += data;
    if (session.flushing) return;
    session.flushing = true;
    setImmediate(() => this.flush(session));
  }

  private flush(session: Session): void {
    session.flushing = false;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = '';
    this.sink?.data(session.tab.id, data);
  }
}

export const terminals = new TerminalManager();

/**
 * The renderer side of the terminal: only from the app's own page (app://taigent), only shells and agents, always
 * in the open repository. Output and exits go to the window, while it exists (a tab may exit during quit).
 */
export function registerTerminalIpc(window: () => BrowserWindow | undefined, repo: () => string): void {
  const contents = (): WebContents | undefined => {
    const win = window();
    return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : undefined;
  };
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    event.sender === contents() && (event.senderFrame?.url.startsWith('app://taigent/') ?? false);
  terminals.attach({
    opened: (tab) => contents()?.send(CHANNELS.terminalOpened, tab),
    data: (id, data) => contents()?.send(CHANNELS.terminalData, id, data),
    exit: (id, exit) => contents()?.send(CHANNELS.terminalExit, id, exit),
  });
  ipcMain.handle(CHANNELS.terminalOpen, async (event, kind: unknown): Promise<Result<TerminalTab>> => {
    try {
      if (!trusted(event)) throw new Error('Không được phép mở terminal từ trang này.');
      if (kind !== 'shell' && !TERMINAL_AGENTS.some((agent) => agent === kind)) throw new Error(`Loại tab không hợp lệ: ${String(kind)}`);
      return { ok: true, value: terminals.open({ kind: kind as 'shell' | TerminalAgent, cwd: repo() }).tab };
    } catch (error) {
      return toFailure(error, 'Không mở được terminal');
    }
  });
  ipcMain.on(CHANNELS.terminalWrite, (event, id: unknown, data: unknown) => {
    if (trusted(event) && typeof id === 'number' && typeof data === 'string') terminals.write(id, data);
  });
  ipcMain.on(CHANNELS.terminalResize, (event, id: unknown, cols: unknown, rows: unknown) => {
    if (trusted(event) && typeof id === 'number' && typeof cols === 'number' && typeof rows === 'number') terminals.resize(id, cols, rows);
  });
  ipcMain.handle(CHANNELS.terminalCancel, async (event, id: unknown) => {
    if (trusted(event) && typeof id === 'number') await terminals.cancel(id);
  });
  ipcMain.handle(CHANNELS.terminalClose, async (event, id: unknown) => {
    if (trusted(event) && typeof id === 'number') await terminals.close(id);
  });
}

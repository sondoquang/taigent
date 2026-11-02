// The embedded terminal's main side: one node-pty process per tab, its output forwarded to the renderer (xterm.js)
// and its input taken from it, both over the typed channels of src/shared/api.ts. The renderer can only open a shell
// or an agent (claude, codex, omp) in the open repository; a tab that runs a given command (kind `skill`) is opened
// from the main process only, through `terminals.open`. Closing or cancelling a tab kills its whole process tree
// (node-pty starts each tab's process in its own session, so outside Windows its pid leads the process group), and
// quitting the app kills every tree (`terminals.killAll`).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, join } from 'node:path';
import { app } from 'electron';
import type * as NodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { CHANNELS, type Result, type TerminalAgent, type TerminalExit, type TerminalTab, TERMINAL_AGENTS } from '../shared/api.ts';
import { appContents, handle, listen } from './ipc.ts';
import { killTree, killTreeSync } from './processes.ts';

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
 * The renderer side of the terminal (through the sender-checked channels of ipc.ts): only shells and agents, always in
 * the open repository. Output and exits go to the window, while it exists (a tab may exit during quit).
 */
export function registerTerminalIpc(repo: () => string): void {
  terminals.attach({
    opened: (tab) => appContents()?.send(CHANNELS.terminalOpened, tab),
    data: (id, data) => appContents()?.send(CHANNELS.terminalData, id, data),
    exit: (id, exit) => appContents()?.send(CHANNELS.terminalExit, id, exit),
  });
  handle(
    CHANNELS.terminalOpen,
    async (kind: unknown): Promise<Result<TerminalTab>> => {
      if (kind !== 'shell' && !TERMINAL_AGENTS.some((agent) => agent === kind)) throw new Error(`Loại tab không hợp lệ: ${String(kind)}`);
      return { ok: true, value: terminals.open({ kind: kind as 'shell' | TerminalAgent, cwd: repo() }).tab };
    },
    'Không mở được terminal',
  );
  listen(CHANNELS.terminalWrite, (id, data) => {
    if (typeof id === 'number' && typeof data === 'string') terminals.write(id, data);
  });
  listen(CHANNELS.terminalResize, (id, cols, rows) => {
    if (typeof id === 'number' && typeof cols === 'number' && typeof rows === 'number') terminals.resize(id, cols, rows);
  });
  handle(CHANNELS.terminalCancel, async (id: unknown) => {
    if (typeof id === 'number') await terminals.cancel(id);
  });
  handle(CHANNELS.terminalClose, async (id: unknown) => {
    if (typeof id === 'number') await terminals.close(id);
  });
}

// The embedded terminal's main side: one node-pty process per tab, its output forwarded to the renderer (xterm.js)
// and its input taken from it, both over the typed channels of src/shared/api.ts. The renderer can only open a shell
// of this machine (`shells`) or an agent (claude, codex, omp) in the open repository; a tab that runs a given command
// (kind `skill`) is opened from the main process only, through `terminals.open`. Closing or cancelling a tab kills
// its whole process tree (node-pty starts each tab's process in its own session, so outside Windows its pid leads the
// process group), and quitting the app kills every tree (`terminals.killAll`).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, delimiter, dirname, join } from 'node:path';
import { app } from 'electron';
import type * as NodePty from 'node-pty';
import type { IPty } from 'node-pty';
import { CHANNELS, type Result, type TerminalAgent, type TerminalExit, type TerminalShell, type TerminalTab, TERMINAL_AGENTS } from '../shared/api.ts';
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
  | { kind: 'shell'; cwd: string; /** A TerminalShell id; the default shell when absent. */ shell?: string }
  | { kind: TerminalAgent; cwd: string }
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

// PowerShell switches its console to UTF-8 first, so native programs' output (git, the agents) shows Vietnamese.
const POWERSHELL_UTF8 = '[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()';

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/** `pwsh` on PATH, else Windows PowerShell; `$SHELL` elsewhere. Agents and `shellRun` commands run in it. */
function defaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return onPath('pwsh.exe') ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Git for Windows' `bin\bash.exe` (the launcher that sets up its environment, not `usr\bin\bash.exe` nor WSL's
 * `System32\bash.exe`): next to the git.exe on PATH, else in its default install folders.
 */
function gitBash(): string | undefined {
  const git = onPath('git.exe');
  const roots = [git && join(dirname(git), '..'), process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git'), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git')];
  return roots.filter((root): root is string => !!root).map((root) => join(root, 'bin', 'bash.exe')).find((bash) => existsSync(bash));
}

/** A shell a `shell` tab can run: interactive, with nothing run first. */
interface Shell extends TerminalShell {
  command: TerminalCommand;
}

/** The shells of this machine, the default first. Command Prompt switches its code page to UTF-8 first. */
function shells(): Shell[] {
  const file = defaultShell();
  if (process.platform !== 'win32') return [{ id: 'default', label: basename(file), command: { file, args: ['-l'] } }];
  const found: Shell[] = [
    {
      id: 'powershell',
      label: basename(file).toLowerCase() === 'pwsh.exe' ? 'PowerShell 7' : 'Windows PowerShell',
      command: { file, args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8] },
    },
    {
      id: 'cmd',
      label: 'Command Prompt',
      command: { file: process.env.ComSpec || join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/K', 'chcp 65001>nul'] },
    },
  ];
  const bash = gitBash();
  // CHERE_INVOKING keeps the login shell in the tab's folder instead of going to the home folder.
  if (bash) found.push({ id: 'git-bash', label: 'Git Bash', command: { file: bash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } } });
  return found;
}

/**
 * The default shell running `command` (an agent, an install command) first, then staying open (so a missing agent
 * shows the shell's own error).
 */
export function shellRun(command: string): TerminalCommand {
  const file = defaultShell();
  if (process.platform === 'win32') return { file, args: ['-NoLogo', '-NoExit', '-Command', `${POWERSHELL_UTF8}; ${command}`] };
  return { file, args: ['-l', '-i', '-c', `${command}; exec "$0" -l`, file] };
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

  /** Opens a tab; the renderer shows the terminal panel and selects the tab. Throws for a shell this machine lacks. */
  open(spec: TerminalSpec): TerminalHandle {
    let command: TerminalCommand;
    let title: string;
    let shell: string | undefined;
    if (spec.kind === 'skill') ({ command, title } = spec);
    else if (spec.kind === 'shell') {
      const offered = shells();
      const picked = spec.shell === undefined ? offered[0] : offered.find((candidate) => candidate.id === spec.shell);
      if (!picked) throw new Error(`Máy này không có shell ${spec.shell}.`);
      ({ command, id: shell } = picked);
      title = basename(command.file).replace(/\.exe$/i, '');
    } else {
      command = shellRun(spec.kind);
      title = spec.kind;
    }
    const env: Record<string, string | undefined> = { ...process.env, COLORTERM: 'truecolor', ...command.env };
    if (process.platform !== 'win32') env.TERM = 'xterm-256color';
    const pty = loadPty().spawn(command.file, command.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: spec.cwd, env });
    const id = this.nextId++;
    const tab: TerminalTab = { id, kind: spec.kind, title, cwd: spec.cwd, pid: pty.pid, ...(shell ? { shell } : {}) };
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
 * The renderer side of the terminal (through the sender-checked channels of ipc.ts): only this machine's shells and
 * the agents, always in the open repository. Output and exits go to the window, while it exists (a tab may exit
 * during quit).
 */
export function registerTerminalIpc(repo: () => string): void {
  terminals.attach({
    opened: (tab) => appContents()?.send(CHANNELS.terminalOpened, tab),
    data: (id, data) => appContents()?.send(CHANNELS.terminalData, id, data),
    exit: (id, exit) => appContents()?.send(CHANNELS.terminalExit, id, exit),
  });
  handle(CHANNELS.terminalShells, async (): Promise<TerminalShell[]> => shells().map(({ id, label }) => ({ id, label })));
  handle(
    CHANNELS.terminalOpen,
    async (kind: unknown, shell: unknown): Promise<Result<TerminalTab>> => {
      if (kind === 'shell') {
        if (shell !== undefined && typeof shell !== 'string') throw new Error(`Shell không hợp lệ: ${String(shell)}`);
        return { ok: true, value: terminals.open({ kind, cwd: repo(), ...(shell === undefined ? {} : { shell }) }).tab };
      }
      const agent = TERMINAL_AGENTS.find((candidate) => candidate === kind);
      if (!agent) throw new Error(`Loại tab không hợp lệ: ${String(kind)}`);
      return { ok: true, value: terminals.open({ kind: agent, cwd: repo() }).tab };
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

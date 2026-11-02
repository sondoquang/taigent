// The child processes the main process starts outside the terminal (taigent CLI runs, git, `--version` checks) and
// how a process tree is killed. Every such child is tracked from spawn to exit, and quitting the app kills the tree of
// each one still running (`killChildren`), next to the terminal tabs' trees, so no process outlives the app.

import { type ChildProcess, execFile, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/**
 * Spawn option for a tracked child: outside Windows it leads its own process group, so killing the group reaches
 * what it started (git's remote helpers). Windows kills the tree by parent pid instead (taskkill /T).
 */
export const OWN_GROUP = { detached: process.platform !== 'win32' };

/** Kills `pid` and every process under it; outside Windows `pid` must lead its process group. */
export function killTree(pid: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (process.platform === 'win32') execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  else {
    killGroup(pid);
    resolve();
  }
  return promise;
}

/** `killTree` that returns once the tree is gone, for quitting. */
export function killTreeSync(pid: number): void {
  if (process.platform === 'win32') spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
  else killGroup(pid);
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

const children = new Set<ChildProcess>();

/** Registers `child` until it exits; returns it. */
export function track<C extends ChildProcess>(child: C): C {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return child;
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

/** On quit: kills the tree of every tracked child still running. */
export function killChildren(): void {
  for (const child of children) {
    if (child.pid !== undefined) killTreeSync(child.pid);
  }
  children.clear();
}

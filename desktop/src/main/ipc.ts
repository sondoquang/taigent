// The one way the renderer reaches the main process. Every channel, invoke or send, is accepted only from the app
// window's own page (`app://taigent/`): an invoke from anywhere else gets a Failure, a send is dropped. A handler's
// throw reaches the renderer as a Failure, never as a rejected invoke. A project slug is checked here, at the
// boundary, against the one slug pattern of the conventions, before it names a folder or reaches a command.

import { type BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { PROJECT_SLUG_PATTERN } from '../../../src/manifest/conventions.ts';
import type { Failure } from '../shared/api.ts';
import { failure, toFailure } from './project.ts';

let appWindow: () => BrowserWindow | undefined = () => undefined;

/** Names the app window, the only sender the channels accept; set once, before the window loads. */
export function trustWindow(window: () => BrowserWindow | undefined): void {
  appWindow = window;
}

/** The app window's contents while they exist (a tab may exit during quit). */
export function appContents(): WebContents | undefined {
  const win = appWindow();
  return win && !win.isDestroyed() && !win.webContents.isDestroyed() ? win.webContents : undefined;
}

function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.sender === appContents() && (event.senderFrame?.url.startsWith('app://taigent/') ?? false);
}

/** An invoke channel; `failed` heads the Failure of an unexpected throw. */
export function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>, failed = 'Lỗi'): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return failure('Yêu cầu không đến từ trang của ứng dụng nên bị từ chối.');
    try {
      return await fn(...(args as A));
    } catch (error) {
      return toFailure(error, failed);
    }
  });
}

/** A send channel (renderer → main, no answer). */
export function listen(channel: string, fn: (...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (trusted(event)) fn(...args);
  });
}

/** A Failure unless `slug` is a project slug. */
export function slugFailure(slug: unknown): Failure | undefined {
  return typeof slug === 'string' && PROJECT_SLUG_PATTERN.test(slug) ? undefined : failure(`"${String(slug)}" không phải slug project.`);
}

/** `handle` for a channel whose first argument is a project slug: a bad slug gets a Failure and `fn` never runs. */
export function handleProject<A extends unknown[], R>(channel: string, fn: (slug: string, ...args: A) => Promise<R>): void {
  handle(channel, async (slug: unknown, ...args: A) => slugFailure(slug) ?? fn(slug as string, ...args));
}

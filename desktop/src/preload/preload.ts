// Sandboxed preload: exposes the typed `window.taigent` API and nothing else of Electron or Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type ProjectView, type Result, type TaigentApi, type TerminalExit, type TerminalTab } from '../shared/api.ts';

/** Subscribes `listener` to a main → renderer event; returns the unsubscribe function. */
function subscribe<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api: TaigentApi = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  openRepo: () => ipcRenderer.invoke(CHANNELS.openRepo),
  refreshRepo: () => ipcRenderer.invoke(CHANNELS.refreshRepo),
  openProject: (slug) => ipcRenderer.invoke(CHANNELS.openProject, slug),
  setVerdict: (slug, key, verdict) => ipcRenderer.invoke(CHANNELS.setVerdict, slug, key, verdict),
  addComment: (slug, key, text) => ipcRenderer.invoke(CHANNELS.addComment, slug, key, text),
  whoami: () => ipcRenderer.invoke(CHANNELS.whoami),
  login: (input) => ipcRenderer.invoke(CHANNELS.login, input),
  logout: () => ipcRenderer.invoke(CHANNELS.logout),
  plan: (slug) => ipcRenderer.invoke(CHANNELS.plan, slug),
  apply: (slug) => ipcRenderer.invoke(CHANNELS.apply, slug),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  onProjectChanged(listener) {
    const handler = (_event: IpcRendererEvent, view: Result<ProjectView>) => listener(view);
    ipcRenderer.on(CHANNELS.projectChanged, handler);
    return () => ipcRenderer.off(CHANNELS.projectChanged, handler);
  },
  readBacklog: (slug) => ipcRenderer.invoke(CHANNELS.readBacklog, slug),
  saveItem: (slug, request) => ipcRenderer.invoke(CHANNELS.saveItem, slug, request),
  removeItem: (slug, request) => ipcRenderer.invoke(CHANNELS.removeItem, slug, request),
  readWiki: (slug) => ipcRenderer.invoke(CHANNELS.readWiki, slug),
  saveWikiPage: (slug, request) => ipcRenderer.invoke(CHANNELS.saveWikiPage, slug, request),
  uploadWiki: (slug) => ipcRenderer.invoke(CHANNELS.uploadWiki, slug),
  listTaigaProjects: () => ipcRenderer.invoke(CHANNELS.listTaigaProjects),
  readTaigaProject: (slug) => ipcRenderer.invoke(CHANNELS.readTaigaProject, slug),
  saveProjectSettings: (input) => ipcRenderer.invoke(CHANNELS.saveProjectSettings, input),
  bootstrapProject: (slug) => ipcRenderer.invoke(CHANNELS.bootstrapProject, slug),
  gitStatus: () => ipcRenderer.invoke(CHANNELS.gitStatus),
  gitPull: () => ipcRenderer.invoke(CHANNELS.gitPull),
  gitCommitPush: (message) => ipcRenderer.invoke(CHANNELS.gitCommitPush, message),
  gitPush: () => ipcRenderer.invoke(CHANNELS.gitPush),
  terminal: {
    open: (kind) => ipcRenderer.invoke(CHANNELS.terminalOpen, kind),
    write: (id, data) => ipcRenderer.send(CHANNELS.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(CHANNELS.terminalResize, id, cols, rows),
    cancel: (id) => ipcRenderer.invoke(CHANNELS.terminalCancel, id),
    close: (id) => ipcRenderer.invoke(CHANNELS.terminalClose, id),
    onOpened: (listener) => subscribe<[TerminalTab]>(CHANNELS.terminalOpened, listener),
    onData: (listener) => subscribe<[number, string]>(CHANNELS.terminalData, listener),
    onExit: (listener) => subscribe<[number, TerminalExit]>(CHANNELS.terminalExit, listener),
  },
};

contextBridge.exposeInMainWorld('taigent', api);

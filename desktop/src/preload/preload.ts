// Sandboxed preload: exposes the typed `window.taigent` API and nothing else of Electron or Node.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type ProjectView, type Result, type TaigentApi } from '../shared/api.ts';

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
};

contextBridge.exposeInMainWorld('taigent', api);

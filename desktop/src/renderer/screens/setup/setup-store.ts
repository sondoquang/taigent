// The opened repository's Taigent state (`taigent init --dry-run` of the app's taigent), shared by the Setup repo
// screen and the top-bar suggestion. The screen reads it again whenever another repository opens and after an init.

import { create } from 'zustand';
import type { SetupStatus } from '../../../shared/api.ts';
import { api, useApp } from '@/store.ts';

interface SetupStore {
  /** Undefined while it is read or without a repository. */
  status?: SetupStatus;
}

export const useSetup = create<SetupStore>(() => ({}));

let statusRun = 0;

/** Reads the opened repository's Taigent state; a later read or another repository wins. */
export async function loadStatus(): Promise<void> {
  const run = ++statusRun;
  useSetup.setState({ status: undefined });
  if (!useApp.getState().repo) return;
  const result = await api.setupStatus();
  if (run !== statusRun) return;
  useSetup.setState({ status: result.ok ? result.value : { state: 'unavailable', changes: [], taigent: '', message: result.message } });
}

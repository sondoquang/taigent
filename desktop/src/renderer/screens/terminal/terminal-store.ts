// State of the terminal dock, shared by the top-bar toggle (terminal-toggle.tsx) and the dock (terminal-dock.tsx):
// whether the dock shows, its tabs (one per process of src/main/terminal.ts) with how each ended, the active tab and
// the shells this machine offers. The xterm.js instances live beside the dock, outside React state.

import { create } from 'zustand';
import type { TerminalExit, TerminalShell, TerminalTab } from '../../../shared/api.ts';

export interface DockTab {
  info: TerminalTab;
  exit?: TerminalExit;
}

interface TerminalState {
  shown: boolean;
  tabs: DockTab[];
  active?: number;
  shells: TerminalShell[];
}

export const useTerminal = create<TerminalState>(() => ({ shown: false, tabs: [], shells: [] }));

export function setShown(shown: boolean): void {
  useTerminal.setState({ shown });
}

// The Backlog section: the agent bar (headless skill runs), the summary of the open project, and the review layout
// (filters and tree on the left, the selected item's detail and comment composer on the right). j/k or ↑/↓ move the
// selection while the section shows and the focus is not in a field or a dialog.

import { useEffect } from 'react';
import { move } from '@/actions.ts';
import { AgentBar } from '@/screens/backlog/agent-bar.tsx';
import { BacklogDetail } from '@/screens/backlog/detail.tsx';
import { BacklogForms } from '@/screens/backlog/forms/forms.tsx';
import { BacklogSummary } from '@/screens/backlog/summary.tsx';
import { BacklogSidebar } from '@/screens/backlog/tree.tsx';
import { useApp } from '@/store.ts';

export function BacklogScreen() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (useApp.getState().section !== 'backlog' || document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <AgentBar />
      <BacklogSummary />
      <div className="layout flex min-h-0 flex-1">
        <BacklogSidebar />
        <BacklogDetail />
      </div>
      <BacklogForms />
    </>
  );
}

// Taigent Desktop UI: the top bar, the navigation rail with one screen per section, the terminal dock and the status
// bar. Screens stay mounted while hidden, so switching sections keeps the open project, the selection and every draft.

import { useEffect, type ReactNode } from 'react';
import { applyView, openProject, refreshLogin } from '@/actions.ts';
import { AccountDialogs } from '@/app/account-dialogs.tsx';
import { NavRail } from '@/app/nav-rail.tsx';
import { ResultDialog } from '@/app/result-dialog.tsx';
import { Statusbar } from '@/app/statusbar.tsx';
import { Topbar } from '@/app/topbar.tsx';
import { ConflictDialog } from '@/components/conflict-dialog.tsx';
import { Toaster } from '@/components/ui/sonner.tsx';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { BacklogScreen } from '@/screens/backlog/backlog-screen.tsx';
import { ChangesScreen } from '@/screens/changes/changes-screen.tsx';
import { GitScreen } from '@/screens/git/git-screen.tsx';
import { SettingsScreen } from '@/screens/settings/settings-screen.tsx';
import { SetupScreen } from '@/screens/setup/setup-screen.tsx';
import { TaigaScreen } from '@/screens/taiga/taiga-screen.tsx';
import { TerminalDock } from '@/screens/terminal/terminal-dock.tsx';
import { WikiScreen } from '@/screens/wiki/wiki-screen.tsx';
import { api, type Section, useApp } from '@/store.ts';

const SCREEN_LABEL: Record<Section, string> = {
  backlog: 'Backlog',
  wiki: 'Wiki',
  taiga: 'Taiga',
  changes: 'Thay đổi',
  git: 'Git',
  setup: 'Setup repo',
  settings: 'Settings',
};

/** The screen of `section`: hidden (not unmounted) while another section shows. */
function Screen({ section, children }: { section: Section; children: ReactNode }) {
  const shown = useApp((state) => state.section === section);
  return (
    <section id={`screen-${section}`} aria-label={SCREEN_LABEL[section]} hidden={!shown} className="screen flex h-full min-h-0 flex-col">
      {children}
    </section>
  );
}

async function start(): Promise<void> {
  const [initial, headlessAgent] = await Promise.all([api.getState(), api.headlessAgent()]);
  useApp.setState({ repo: initial.repo, versions: initial.versions, headlessAgent });
  document.title = `Taigent Desktop ${initial.versions.app}`;
  const only = initial.repo?.projects.length === 1 ? initial.repo.projects[0] : undefined;
  if (only) await openProject(only.slug);
  await refreshLogin();
}

export function App() {
  useEffect(() => {
    void start();
    // Live refresh: every change under taiga/<slug>/ of the open project (an agent's edit, a form's save).
    const unsubscribe = api.onProjectChanged((result) => {
      if (result.ok && result.value.slug !== useApp.getState().view?.slug) return;
      applyView(result);
    });
    // Links in rendered Markdown never navigate the window; main opens http(s) ones in the system browser.
    const onClick = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[data-external]') : null;
      if (!link) return;
      event.preventDefault();
      const href = link.getAttribute('data-external');
      if (href) void api.openExternal(href);
    };
    document.addEventListener('click', onClick);
    return () => {
      unsubscribe();
      document.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="shell flex h-full">
        <NavRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <Screen section="backlog">
              <BacklogScreen />
            </Screen>
            <Screen section="wiki">
              <WikiScreen />
            </Screen>
            <Screen section="taiga">
              <TaigaScreen />
            </Screen>
            <Screen section="changes">
              <ChangesScreen />
            </Screen>
            <Screen section="git">
              <GitScreen />
            </Screen>
            <Screen section="setup">
              <SetupScreen />
            </Screen>
            <Screen section="settings">
              <SettingsScreen />
            </Screen>
          </main>
          <TerminalDock />
          <Statusbar />
        </div>
      </div>
      <ResultDialog />
      <AccountDialogs />
      <ConflictDialog />
      <Toaster position="bottom-right" closeButton />
    </TooltipProvider>
  );
}

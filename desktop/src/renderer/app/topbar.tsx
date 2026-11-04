import { FolderOpen, LogIn, LogOut } from 'lucide-react';
import { openLogin, openProject, useRepo } from '@/actions.ts';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { SetupBanner } from '@/screens/setup/setup-banner.tsx';
import { TerminalToggle } from '@/screens/terminal/terminal-toggle.tsx';
import { api, useApp } from '@/store.ts';

function Brand() {
  return (
    <div className="brand flex items-center gap-2 pr-2 font-semibold">
      <svg viewBox="0 0 20 20" aria-hidden="true" className="size-5 shrink-0">
        <rect width="20" height="20" rx="5" className="fill-primary" />
        <path d="m5.5 10.5 3 3 6-7" className="fill-none stroke-primary-foreground" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="brand-name">Taigent</span>
    </div>
  );
}

function ProjectPicker() {
  const repo = useApp((state) => state.repo);
  const slug = useApp((state) => state.view?.slug ?? '');
  const projects = repo?.projects ?? [];
  return (
    <label className="project-picker flex items-center gap-2">
      <span className="text-muted-foreground">Dự án</span>
      <NativeSelect id="project-select" size="sm" value={slug} disabled={projects.length === 0} onChange={(event) => void openProject(event.currentTarget.value)}>
        <NativeSelectOption value="">{projects.length ? 'Chọn dự án…' : repo ? 'Không có dự án' : '—'}</NativeSelectOption>
        {projects.map((project) => (
          <NativeSelectOption key={project.slug} value={project.slug}>
            {project.name ? `${project.name} (${project.slug})` : project.slug}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
}

function LoginButton() {
  const login = useApp((state) => state.login);
  const button = (
    <Button id="login-btn" variant="ghost" size="sm" onClick={openLogin}>
      {login?.loggedIn ? <LogOut aria-hidden="true" /> : <LogIn aria-hidden="true" />}
      {login?.loggedIn ? `${login.username} · Đăng xuất` : 'Đăng nhập'}
    </Button>
  );
  const hint = login?.loggedIn ? `Đăng nhập ${login.apiUrl} (${login.source})` : login?.message;
  if (!hint) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** The workspace (repository and project), the setup suggestion, the terminal toggle and the Taiga login. */
export function Topbar() {
  const repo = useApp((state) => state.repo);
  return (
    <header className="topbar flex h-12 shrink-0 items-center gap-3 border-b bg-sidebar px-3">
      <Brand />
      <div className="workspace flex min-w-0 items-center gap-3">
        <Button id="open-repo" variant="outline" size="sm" onClick={async () => useRepo(await api.openRepo())}>
          <FolderOpen aria-hidden="true" />
          Mở thư mục repo…
        </Button>
        <div id="repo-path" className="repo max-w-80 truncate text-xs text-muted-foreground" title={repo ? `Manifest: ${repo.manifestsDir}` : ''}>
          {repo ? repo.root : 'Chưa mở repo'}
        </div>
        <ProjectPicker />
      </div>
      <SetupBanner />
      <div className="flex-1" />
      <TerminalToggle />
      <LoginButton />
    </header>
  );
}

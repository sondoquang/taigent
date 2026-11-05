import { FolderOpen } from 'lucide-react';
import { openProject, useRepo } from '@/actions.ts';
import { Button } from '@/components/ui/button.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { SetupBanner } from '@/screens/setup/setup-banner.tsx';
import { TerminalToggle } from '@/screens/terminal/terminal-toggle.tsx';
import { api, useApp } from '@/store.ts';

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

/** The workspace (repository and project), the setup suggestion and the terminal toggle; Medusa's top bar. */
export function Topbar() {
  const repo = useApp((state) => state.repo);
  return (
    <header className="topbar flex h-13 shrink-0 items-center gap-3 border-b bg-background px-3">
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
    </header>
  );
}

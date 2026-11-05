// The top-bar suggestion to set the repository up: shown when no repository is open, when the opened one has no
// Taigent, or when its Taigent files are older than the app's; hidden while the Setup repo screen itself shows.

import { showSection } from '@/actions.ts';
import { TONE_CLASS } from '@/components/common.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { useApp } from '@/store.ts';
import { useSetup } from './setup-store.ts';

export function SetupBanner() {
  const hasRepo = useApp((state) => Boolean(state.repo));
  const onSetup = useApp((state) => state.section === 'setup');
  const status = useSetup((state) => state.status);
  const suggestion: [string, string, string] | undefined = !hasRepo
    ? ['no-repo', 'Chưa mở repo.', 'Setup repo']
    : status?.state === 'none'
      ? ['none', 'Repo chưa cài Taigent.', 'Cài Taigent']
      : status?.state === 'outdated'
        ? ['outdated', 'Taigent trong repo cũ hơn ứng dụng.', 'Chạy lại init']
        : undefined;
  if (!suggestion || onSetup) return null;
  const [state, text, action] = suggestion;
  return (
    <div
      id="setup-banner"
      role="status"
      data-state={state}
      title={state === 'outdated' ? `init sẽ đổi ${status?.changes.length} file` : undefined}
      className={cn('setup-banner flex min-w-0 shrink items-center gap-2 rounded-md border py-0.5 pr-0.5 pl-2', TONE_CLASS.changes)}
    >
      <span id="setup-banner-text" className="truncate">
        {text}
      </span>
      <Button id="setup-banner-action" variant="outline" size="sm" className="shrink-0" onClick={() => showSection('setup')}>
        {action}
      </Button>
    </div>
  );
}

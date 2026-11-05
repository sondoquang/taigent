// The headless buttons of the Backlog section (Plan backlog từ spec, Nhờ agent xử lý góp ý, Tạo user story) and the
// choice of their agent, in the bar beside the buttons and in Settings (both through `chooseHeadlessAgent`). A run opens
// a `skill` tab in the terminal panel (main process: src/main/headless.ts, the bundled run-skill); its end shows here
// with the exit code and, on failure, the last error line. The tree, the forms and the review follow the agent's edits
// through the project watcher; `refreshProject` re-reads the repository too, for a project the run created.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SkillRunAction, SkillRunEnd, SkillRunRequest } from '../../../shared/api.ts';
import { chooseHeadlessAgent, refreshProject, toast } from '@/actions.ts';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { Field, FieldError, FieldLabel } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Code } from '@/components/common.tsx';
import { cn } from '@/lib/utils.ts';
import { api, useApp } from '@/store.ts';

const LABELS: Record<SkillRunAction, string> = {
  'plan-spec': 'Plan backlog từ spec',
  review: 'Xử lý góp ý',
  story: 'Tạo user story',
};

type RunState = 'running' | 'ok' | 'error' | 'cancelled';

const STATUS_TONE: Record<RunState, string> = {
  running: 'text-muted-foreground',
  ok: 'text-success',
  error: 'text-destructive',
  cancelled: 'text-warning',
};

/** "Tạo user story": one sentence of need; the agent writes the story into backlog.yaml and stops before any push. */
function StoryDialog({ open, onOpenChange, onRun }: { open: boolean; onOpenChange: (open: boolean) => void; onRun: (description: string) => void }) {
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setDescription('');
    setError(undefined);
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = description.trim();
    if (!text) return;
    if (/["\r\n]/.test(text)) {
      setError('Không dùng dấu ngoặc kép (") trong mô tả.');
      return;
    }
    onOpenChange(false);
    onRun(text);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="story-dialog" className="sm:max-w-lg">
        <form id="story-dialog-form" className="flex flex-col gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Tạo user story</DialogTitle>
            <DialogDescription>
              Tả nhu cầu trong một câu. Agent soạn story theo user story format vào <Code>backlog.yaml</Code> rồi dừng ở bước hỏi xác nhận: story ở
              lại trong manifest để bạn review rồi đẩy lên Taiga trong ứng dụng.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="story-description">Nhu cầu</FieldLabel>
            <Input
              id="story-description"
              type="text"
              required
              maxLength={1000}
              autoFocus
              placeholder="Ví dụ: người duyệt muốn lọc các mục đã đổi sau khi duyệt"
              value={description}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'story-error' : undefined}
              onChange={(event) => {
                setDescription(event.currentTarget.value);
                setError(undefined);
              }}
            />
            {error && <FieldError id="story-error">{error}</FieldError>}
          </Field>
          <DialogFooter>
            <Button id="story-cancel" type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Huỷ
            </Button>
            <Button id="story-submit" type="submit">
              Chạy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The agent bar: the agent picker, the three skill buttons and the status of the last run. */
export function AgentBar() {
  const agent = useApp((state) => state.headlessAgent);
  const hasRepo = useApp((state) => Boolean(state.repo));
  const slug = useApp((state) => state.view?.slug);
  const [running, setRunning] = useState<SkillRunAction>();
  const [status, setStatus] = useState<{ state: RunState; text: string }>();
  const [storyOpen, setStoryOpen] = useState(false);
  // The run in progress, read synchronously: a short run (`--dry-run`) may end before runSkill's reply arrives.
  const runningRef = useRef<SkillRunAction | undefined>(undefined);

  useEffect(
    () =>
      api.onSkillRunEnded((end: SkillRunEnd) => {
        runningRef.current = undefined;
        setRunning(undefined);
        const label = LABELS[end.action];
        if (end.cancelled) {
          setStatus({ state: 'cancelled', text: `${label} (${end.agent}): đã huỷ.` });
          toast(`Đã huỷ ${label}.`);
        } else if (end.exitCode === 0) {
          setStatus({ state: 'ok', text: `${label} (${end.agent}): xong, mã thoát 0.` });
          toast(`${label}: xong.`);
        } else {
          const line = end.lastErrorLine ? ` ${end.lastErrorLine}` : '';
          setStatus({ state: 'error', text: `${label} (${end.agent}): lỗi, mã thoát ${end.exitCode}.${line}` });
          toast(`${label}: lỗi, mã thoát ${end.exitCode}.`, 'error');
        }
        // The watcher already showed the agent's edits; a project the run created joins the picker here.
        void refreshProject();
      }),
    [],
  );

  const start = async (request: SkillRunRequest) => {
    if (runningRef.current) return;
    const label = LABELS[request.action];
    runningRef.current = request.action;
    setRunning(request.action);
    const result = await api.runSkill(request);
    if (!result?.ok) {
      runningRef.current = undefined;
      setRunning(undefined);
      if (result) {
        setStatus({ state: 'error', text: `${label}: không chạy được. ${result.message}` });
        toast(result.message, 'error');
      }
      return;
    }
    if (runningRef.current !== undefined) setStatus({ state: 'running', text: `Đang chạy ${label} (${result.value.agent}) trong tab terminal…` });
  };

  const idle = running === undefined;
  const busy = (action: SkillRunAction) => running === action && <Spinner aria-hidden="true" />;

  return (
    <div id="agent-bar" role="toolbar" aria-label="Nhờ agent" className="agent-bar flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-4 py-2">
      <div className="agent-picker flex items-center gap-2" title="Agent chạy các nút bên cạnh (run-skill headless). Đổi ở đây hoặc trong Settings.">
        <label htmlFor="agent-select" className="text-xs font-medium text-muted-foreground">
          Agent
        </label>
        <NativeSelect
          id="agent-select"
          size="sm"
          aria-label="Agent chạy skill"
          value={agent}
          disabled={!idle}
          onChange={(event) => void chooseHeadlessAgent(event.currentTarget.value)}
        >
          <NativeSelectOption value="omp">OMP</NativeSelectOption>
          <NativeSelectOption value="claude">Claude Code</NativeSelectOption>
          <NativeSelectOption value="codex">Codex</NativeSelectOption>
        </NativeSelect>
      </div>
      <Separator orientation="vertical" className="h-6" />
      <Button
        id="agent-plan-spec"
        variant="outline"
        size="sm"
        disabled={!idle || !hasRepo}
        title="Chọn file spec, agent viết hoặc cập nhật backlog.yaml (taiga-plan-backlog)"
        onClick={() => void start(slug ? { action: 'plan-spec', slug } : { action: 'plan-spec' })}
      >
        {busy('plan-spec')}
        Plan backlog từ spec…
      </Button>
      <Button
        id="agent-review"
        variant="outline"
        size="sm"
        disabled={!idle || !slug}
        title="Agent sửa manifest theo các góp ý còn mở và trả lời từng góp ý (taiga-plan-backlog)"
        onClick={() => slug && void start({ action: 'review', slug })}
      >
        {busy('review')}
        Nhờ agent xử lý góp ý
      </Button>
      <Button
        id="agent-story"
        variant="outline"
        size="sm"
        disabled={!idle || !slug}
        title="Tả nhu cầu trong một câu, agent soạn story vào backlog.yaml (taiga-create-user-story)"
        onClick={() => setStoryOpen(true)}
      >
        {busy('story')}
        Tạo user story…
      </Button>
      <span
        id="agent-status"
        className={cn('agent-status min-w-0 flex-1 truncate text-xs', status && STATUS_TONE[status.state])}
        data-state={status?.state}
        title={status?.text}
        aria-live="polite"
      >
        {status?.text}
      </span>
      <StoryDialog
        open={storyOpen}
        onOpenChange={setStoryOpen}
        onRun={(description) => {
          const current = useApp.getState().view?.slug;
          if (current) void start({ action: 'story', slug: current, description });
        }}
      />
    </div>
  );
}

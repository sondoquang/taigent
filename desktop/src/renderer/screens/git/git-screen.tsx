// The Git section: the changed files in scope (the manifests folder and what docs.yaml references), Pull, Commit +
// Push and Push. Every git command runs in the main process (src/main/git.ts); this screen only shows outcomes. The
// status is read when the section shows and forgotten while it is hidden; another repository forgets the last outcome.

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import type { GitChange, GitOutcome, GitStatus, Result } from '../../../shared/api.ts';
import { toast } from '@/actions.ts';
import { Code, PageHeader, ScreenBody, StatusBadge, type Tone } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { api, useApp } from '@/store.ts';

const STATE_LABEL: Record<GitChange['state'], { label: string; tone: Tone }> = {
  modified: { label: 'Sửa', tone: 'changes' },
  added: { label: 'Thêm', tone: 'approved' },
  deleted: { label: 'Xoá', tone: 'stale' },
  untracked: { label: 'Mới', tone: 'new' },
  conflicted: { label: 'Conflict', tone: 'stale' },
};

type Action = 'Làm mới' | 'Pull' | 'Push' | 'Commit + Push';

/** The outcome region of `result`: the new status (when it brings one) and what to show. */
function outcomeOf(title: string, result: Result<GitOutcome>): { status?: GitStatus; content: ReactNode } {
  const time = <p className="text-xs text-muted-foreground">{new Date().toLocaleTimeString('vi-VN')}</p>;
  const heading = (text: string) => <h2 className="text-sm font-semibold">{text}</h2>;
  if (!result.ok) {
    return {
      content: (
        <>
          {heading(title)}
          {time}
          <FailureBlock failure={result} />
        </>
      ),
    };
  }
  const outcome = result.value;
  if (outcome.kind === 'ok') {
    return {
      status: outcome.status,
      content: outcome.summary && (
        <>
          {heading(title)}
          {time}
          <p>{outcome.summary}</p>
        </>
      ),
    };
  }
  const { stop } = outcome;
  const pre = 'detail-text max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap';
  return {
    status: outcome.status,
    content: (
      <div className="flex flex-col gap-2">
        {heading(`${title}: đã dừng`)}
        {time}
        <p className="error break-words text-destructive">{stop.message}</p>
        {stop.terminal && <p>Đã mở một tab terminal ở repo để bạn tiếp tục.</p>}
        {stop.commands.length > 0 && <p>Lệnh gợi ý, chạy trong terminal ở repo:</p>}
        {stop.commands.length > 0 && <pre className={pre}>{stop.commands.join('\n')}</pre>}
        {stop.detail && <pre className={pre}>{stop.detail}</pre>}
      </div>
    ),
  };
}

export function GitScreen() {
  const repo = useApp((s) => s.repo);
  const shown = useApp((s) => s.section === 'git');
  const [status, setStatus] = useState<GitStatus>();
  const [result, setResult] = useState<ReactNode>(null);
  const [running, setRunning] = useState<Action>();
  const [message, setMessage] = useState('');

  // Another repository opened: the last outcome belonged to the previous one.
  useEffect(() => setResult(null), [repo]);

  // Reads the status when the section shows (or another repository opens while it shows); forgets it otherwise.
  useEffect(() => {
    if (!repo || !shown) {
      setStatus(undefined);
      return;
    }
    let current = true;
    void api.gitStatus().then((read) => {
      if (!current) return;
      if (read.ok && read.value.kind === 'ok') return setStatus(read.value.status);
      setStatus(undefined);
      setResult(outcomeOf('Trạng thái git', read).content);
    });
    return () => {
      current = false;
    };
  }, [repo, shown]);

  /** Runs one git action and shows its outcome; resolves to the status after it. */
  const act = async (title: Action, call: () => Promise<Result<GitOutcome>>): Promise<GitStatus | undefined> => {
    if (running || !useApp.getState().repo) return status;
    setRunning(title);
    setResult(<p className="text-muted-foreground">{`Đang chạy ${title}…`}</p>);
    try {
      const outcome = await call();
      const { status: read, content } = outcomeOf(title, outcome);
      const next = read ?? status;
      setStatus(next);
      setResult(content);
      if (outcome.ok && outcome.value.kind === 'ok' && outcome.value.summary) toast(outcome.value.summary);
      return next;
    } finally {
      setRunning(undefined);
    }
  };

  const commitPush = async (event: FormEvent) => {
    event.preventDefault();
    const after = await act('Commit + Push', () => api.gitCommitPush(message));
    if (after && after.changes.length === 0) setMessage('');
  };

  const off = Boolean(running) || !repo;
  const button = (id: string, title: Action, call: () => Promise<Result<GitOutcome>>) => (
    <Button id={id} variant="outline" disabled={off} onClick={() => void act(title, call)}>
      {running === title && <Spinner />}
      {title}
    </Button>
  );
  const sync = status?.upstream
    ? `${status.upstream} · ${status.ahead} commit chưa push · ${status.behind} commit mới trên remote (theo lần fetch gần nhất)`
    : 'chưa theo dõi nhánh nào trên remote';

  return (
    <ScreenBody>
      <PageHeader
        title="Git"
        description={
          <>
            Chỉ thao tác trên thư mục manifest (<Code>taiga/</Code>) và các file mà <Code>docs.yaml</Code> tham chiếu. Ứng dụng không bao giờ
            merge, rebase hay force push: khi cần, nó dừng lại, giải thích và mở một tab terminal ở repo để bạn xử lý.
          </>
        }
        actions={
          <>
            {button('git-refresh', 'Làm mới', () => api.gitStatus())}
            {button('git-pull', 'Pull', () => api.gitPull())}
            {button('git-push', 'Push', () => api.gitPush())}
          </>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>
              <h2>File đã đổi trong phạm vi</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul id="git-files" className="git-files flex max-h-96 flex-col gap-1 overflow-auto">
              {status?.changes.map((change) => (
                <li key={change.path} data-path={change.path} className={`${change.state} flex min-w-0 items-center gap-2`}>
                  <StatusBadge tone={STATE_LABEL[change.state].tone} className="git-state">
                    {STATE_LABEL[change.state].label}
                  </StatusBadge>
                  <span className="min-w-0 truncate" title={change.path}>
                    <Code>{change.path}</Code>
                  </span>
                </li>
              ))}
            </ul>
            {status && status.changes.length === 0 && (
              <p id="git-files-empty" className="empty-state text-muted-foreground">
                Không có file nào trong phạm vi đã đổi.
              </p>
            )}
            <p id="git-outside" className="text-muted-foreground">
              {status && status.outside > 0 ? `${status.outside} file đã đổi ngoài phạm vi: ứng dụng không bao giờ commit hay push chúng.` : ''}
            </p>
          </CardContent>
        </Card>
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Nhánh</h2>
              </CardTitle>
            </CardHeader>
            <CardContent id="git-overview" className="git-overview flex flex-col gap-2 break-words">
              {status ? (
                <>
                  <p>
                    Nhánh <strong>{status.branch ?? '(detached HEAD)'}</strong> → {sync}
                  </p>
                  <p className="text-muted-foreground">
                    Phạm vi:{' '}
                    {status.scope.length > 0
                      ? status.scope.map((path, index) => (
                          <span key={path}>
                            {index > 0 ? ', ' : ''}
                            <Code>{path}</Code>
                          </span>
                        ))
                      : 'không có (thư mục manifest nằm ngoài repo).'}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">{repo ? 'Chưa đọc được trạng thái git.' : 'Chưa mở repo.'}</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Commit</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <form id="git-commit-form" className="git-commit flex gap-2" onSubmit={(event) => void commitPush(event)}>
                <Input
                  id="git-message"
                  className="min-w-0 flex-1"
                  placeholder="Message của commit"
                  aria-label="Message của commit"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
                <Button id="git-commit-push" type="submit" disabled={off}>
                  {running === 'Commit + Push' && <Spinner />}
                  Commit + Push
                </Button>
              </form>
              <div id="git-result" className="git-result flex min-w-0 flex-col gap-1" aria-live="polite">
                {result}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </ScreenBody>
  );
}

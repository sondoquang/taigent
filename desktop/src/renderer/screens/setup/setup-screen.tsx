// The Setup repo section (spec #35, ticket #40): a new repository, a clone or an existing one; `taigent init` of the
// app's own taigent; `npm install` in a terminal tab; the checklist of tools (git, claude, codex, omp), the Taiga
// login and the reminder to approve the `taiga` MCP server. The top-bar suggestion (setup-banner.tsx) shares the
// repository's Taigent state (setup-store.ts). Every action runs in the main process (src/main/setup.ts,
// src/main/tools.ts); this screen only shows outcomes.

import { Check, CircleAlert, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { type Failure, type InitFile, type InitReport, type Result, SETUP_TOOLS, type SetupTool, type ToolCheck } from '../../../shared/api.ts';
import { openLogin, refreshLogin, useRepo } from '@/actions.ts';
import { Code, PageHeader, ScreenBody, StatusBadge, type Tone } from '@/components/common.tsx';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';
import { api, useApp } from '@/store.ts';
import { loadStatus, useSetup } from './setup-store.ts';

const FILE_STATUS: Record<InitFile['status'], string> = { created: 'Tạo mới', updated: 'Cập nhật', unchanged: 'Giữ nguyên', removed: 'Xoá' };
const FILE_TONE: Record<InitFile['status'], Tone> = { created: 'new', updated: 'changes', unchanged: 'neutral', removed: 'stale' };
const TOOL_NAME: Record<SetupTool, string> = { git: 'git', claude: 'claude (Claude Code)', codex: 'codex (Codex CLI)', omp: 'omp (oh-my-pi)' };

/** What a step shows under its actions: a progress line, an outcome line or a failure. */
type Outcome = { text: string; pending?: boolean } | Failure | undefined;
/** The action whose button shows a spinner; any of them disables the repository and init buttons. */
type Running = 'parent' | 'create' | 'clone' | 'open' | 'init';

/** The folder name a clone of `url` gets: its last path segment without `.git`. */
function repoName(url: string): string {
  return (url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? '').replace(/\.git$/i, '');
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  if (!outcome) return null;
  if ('ok' in outcome) return <FailureBlock failure={outcome} />;
  return <p className={outcome.pending ? 'text-muted-foreground' : undefined}>{outcome.text}</p>;
}

function InitTable({ report }: { report: InitReport }) {
  const count = (state: InitFile['status']) => report.files.filter((file) => file.status === state).length;
  return (
    <div className="space-y-2">
      <p>
        {`taigent init: ${count('created')} file tạo mới, ${count('updated')} cập nhật, ${count('removed')} xoá, ${count('unchanged')} giữ nguyên.`}
        {count('unchanged') < report.files.length ? ' Hãy commit các file đã đổi để cả team dùng chung.' : ''}
      </p>
      <details className="group">
        <summary className="w-fit cursor-pointer rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {`Xem ${report.files.length} file`}
        </summary>
        <div className="mt-2 max-h-80 overflow-auto rounded-lg shadow-borders-base">
          <Table className="setup-files [--table-edge:12px]">
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Trạng thái</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.files.map((file) => (
                <TableRow key={file.path} data-path={file.path} data-status={file.status} className={file.status}>
                  <TableCell className="max-w-0 truncate text-xs" title={file.path}>
                    {file.path}
                  </TableCell>
                  <TableCell className="w-28">
                    <StatusBadge tone={FILE_TONE[file.status]}>{FILE_STATUS[file.status]}</StatusBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

/** The repository's Taigent state, as `data-state` and a sentence (the changes init would make when outdated). */
function StatusView() {
  const root = useApp((state) => state.repo?.root);
  const status = useSetup((state) => state.status);
  const state = !root ? 'no-repo' : (status?.state ?? 'checking');
  let content: ReactNode;
  switch (state) {
    case 'no-repo':
      content = <p>Chưa mở repo. Tạo, clone hoặc mở một repo ở bước 1.</p>;
      break;
    case 'checking':
      content = (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner aria-hidden="true" />
          Đang kiểm tra repo (taigent init --dry-run)…
        </p>
      );
      break;
    case 'none':
      content = <p>{`Repo ${root} chưa cài Taigent. Bấm “Cài Taigent vào repo”.`}</p>;
      break;
    case 'current':
      content = <p>{`Repo đã cài Taigent, cùng version với ứng dụng (taigent ${status?.taigent}). Không cần setup lại.`}</p>;
      break;
    case 'outdated':
      content = (
        <>
          <p>{`Taigent trong repo cũ hơn hoặc khác bản của ứng dụng (taigent ${status?.taigent}). Chạy lại init sẽ đổi ${status?.changes.length} file:`}</p>
          <ul className="setup-changes max-h-48 space-y-1 overflow-auto">
            {(status?.changes ?? []).map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2">
                <Code className="min-w-0 truncate">{file.path}</Code>
                <StatusBadge tone={FILE_TONE[file.status]}>{FILE_STATUS[file.status]}</StatusBadge>
              </li>
            ))}
          </ul>
        </>
      );
      break;
    default:
      content = <p className="text-destructive">{`Không kiểm tra được repo: ${status?.message ?? 'lỗi không rõ'}`}</p>;
  }
  return (
    <div id="setup-status" data-state={state} className="setup-status space-y-2 break-words" aria-live="polite">
      {content}
    </div>
  );
}

const MARK = {
  checking: <Spinner aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />,
  ok: <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />,
  bad: <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />,
  warn: <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />,
};

function ChecklistItem({ item, state, mark, children }: { item: string; state: string; mark: keyof typeof MARK; children: ReactNode }) {
  return (
    <li data-item={item} data-state={state} className="flex min-w-0 items-start gap-2 py-2">
      {MARK[mark]}
      <div className="min-w-0 flex-1 space-y-1 break-words">{children}</div>
    </li>
  );
}

function ToolItem({ tool, check, onInstall }: { tool: SetupTool; check: ToolCheck | undefined; onInstall: (tool: SetupTool) => void }) {
  const name = TOOL_NAME[tool];
  if (!check) {
    return (
      <ChecklistItem item={tool} state="checking" mark="checking">
        <span className="text-muted-foreground">{`${name}: đang kiểm tra…`}</span>
      </ChecklistItem>
    );
  }
  const where = check.path && (
    <span className="setup-where block truncate text-xs text-muted-foreground" title={check.path}>
      {check.path}
    </span>
  );
  const install = (
    <div className="setup-install flex flex-wrap items-center gap-2 text-muted-foreground">
      <span>
        Lệnh cài: <Code className="break-all">{check.install}</Code>
      </span>
      <Button variant="outline" size="sm" data-install={tool} onClick={() => onInstall(tool)}>
        Chạy trong terminal
      </Button>
    </div>
  );
  switch (check.state) {
    case 'ok':
      return (
        <ChecklistItem item={tool} state="ok" mark="ok">
          {`${name} `}
          <span className="setup-version text-xs">{check.version ?? ''}</span> {where}
        </ChecklistItem>
      );
    case 'missing':
      return (
        <ChecklistItem item={tool} state="missing" mark="bad">
          {`${name}: Chưa cài`}
          {install}
        </ChecklistItem>
      );
    case 'found':
      return (
        <ChecklistItem item={tool} state="found" mark="ok">
          {`${name}: ${check.message ?? ''} `}
          {where}
        </ChecklistItem>
      );
    default:
      return (
        <ChecklistItem item={tool} state={check.state} mark="warn">
          {`${name}: ${check.message ?? 'lỗi'} `}
          {where}
          {install}
        </ChecklistItem>
      );
  }
}

function LoginItem({ checking }: { checking: boolean }) {
  const login = useApp((state) => state.login);
  if (checking || !login) {
    return (
      <ChecklistItem item="login" state="checking" mark="checking">
        <span className="text-muted-foreground">Đăng nhập Taiga: đang kiểm tra…</span>
      </ChecklistItem>
    );
  }
  if (login.loggedIn) {
    return (
      <ChecklistItem item="login" state="ok" mark="ok">
        {`Đăng nhập Taiga: ${login.username} (${login.apiUrl})`}
      </ChecklistItem>
    );
  }
  return (
    <ChecklistItem item="login" state="missing" mark="bad">
      <div className="flex flex-wrap items-center gap-2">
        {`${login.message ?? 'Chưa đăng nhập Taiga.'} `}
        <Button id="setup-login" size="sm" onClick={openLogin}>
          Đăng nhập
        </Button>
      </div>
      <p className="text-muted-foreground"> Dùng chung với taigent login, nên agent trong terminal cũng dùng được.</p>
    </ChecklistItem>
  );
}

export function SetupScreen() {
  const repo = useApp((state) => state.repo);
  const section = useApp((state) => state.section);
  const status = useSetup((state) => state.status);
  const [parent, setParent] = useState<string>();
  const [newName, setNewName] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneName, setCloneName] = useState('');
  const [nameFollowsUrl, setNameFollowsUrl] = useState(true);
  const [running, setRunning] = useState<Running>();
  const [repoResult, setRepoResult] = useState<Outcome>();
  const [initResult, setInitResult] = useState<{ pending: true } | Result<InitReport>>();
  const [npmResult, setNpmResult] = useState('');
  const [tools, setTools] = useState<ToolCheck[]>();
  const [toolsChecking, setToolsChecking] = useState(false);
  const [loginChecking, setLoginChecking] = useState(false);
  /** The terminal tab of the last `npm install` the wizard started. */
  const npmTab = useRef<number>(undefined);
  /** Guards the first check when the section shows (state would be stale inside the effect's async start). */
  const checkStarted = useRef(false);
  const busy = running !== undefined;

  const withRunning = async (action: Running, fn: () => Promise<void>) => {
    setRunning(action);
    try {
      await fn();
    } finally {
      setRunning(undefined);
    }
  };

  const checkTools = async () => {
    checkStarted.current = true;
    setToolsChecking(true);
    setLoginChecking(true);
    const login = refreshLogin().finally(() => setLoginChecking(false));
    const [checked] = await Promise.all([api.checkTools(), login]);
    setTools(checked);
    setToolsChecking(false);
  };

  // Another repository opened (top bar or wizard): read its Taigent state again.
  useEffect(() => {
    void loadStatus();
  }, [repo]);

  // The checklist is read the first time the section shows.
  useEffect(() => {
    if (section === 'setup' && !checkStarted.current) void checkTools();
  }, [section]);

  useEffect(
    () =>
      api.terminal.onExit((id, exit) => {
        if (id !== npmTab.current) return;
        setNpmResult(
          exit.cancelled ? 'npm install đã bị huỷ.' : exit.exitCode === 0 ? 'npm install xong (mã 0).' : `npm install lỗi (mã ${exit.exitCode}): xem output trong tab terminal.`,
        );
      }),
    [],
  );

  const pickParent = () =>
    withRunning('parent', async () => {
      const picked = await api.pickParentFolder();
      if (picked !== undefined) setParent(picked);
    });

  const createRepo = (event: FormEvent) => {
    event.preventDefault();
    void withRunning('create', async () => {
      setRepoResult({ text: 'Đang tạo repo và cài Taigent…', pending: true });
      setInitResult(undefined);
      const result = await api.createRepo({ parent: parent ?? '', name: newName });
      if (!result.ok) return setRepoResult(result);
      useRepo({ ok: true, value: result.value.repo });
      setRepoResult({ text: `Đã tạo repo ${result.value.repo.root} (git init, thư mục taiga/).` });
      setInitResult(result.value.init);
    });
  };

  const cloneRepo = (event: FormEvent) => {
    event.preventDefault();
    void withRunning('clone', async () => {
      setRepoResult({ text: 'Đang clone…', pending: true });
      const result = await api.cloneRepo({ url: cloneUrl, parent: parent ?? '', name: cloneName });
      if (!result.ok) return setRepoResult(result);
      setInitResult(undefined);
      useRepo(result);
      setRepoResult({ text: `Đã clone vào ${result.value.root}.` });
    });
  };

  const runInit = async () => {
    await withRunning('init', async () => {
      setInitResult({ pending: true });
      setInitResult(await api.runInit());
    });
    await loadStatus();
  };

  const runNpmInstall = async () => {
    const result = await api.runNpmInstall();
    if (!result.ok) {
      setNpmResult(result.message);
      return;
    }
    npmTab.current = result.value.id;
    setNpmResult('Đang chạy npm install trong tab terminal…');
  };

  const runInstall = async (tool: SetupTool) => {
    const result = await api.installTool(tool);
    if (!result.ok) setRepoResult(result);
  };

  const spinner = (action: Running) => running === action && <Spinner aria-hidden="true" />;
  const rowClass = 'setup-row flex flex-wrap items-center gap-2';
  const labelClass = 'setup-label w-32 shrink-0';

  return (
    <ScreenBody className="setup">
      <PageHeader
        title="Setup repo"
        description={
          <>
            Tạo repo mới, clone repo của team hoặc mở repo có sẵn, rồi cài Taigent vào repo: các skill Taigent, MCP server <Code>taiga</Code>, bộ
            chạy headless và devDependency <Code>taigent</Code>, cùng version với ứng dụng. Ứng dụng không cài agent CLI giúp bạn: nó chỉ cho biết
            công cụ nào còn thiếu và lệnh cài.
          </>
        }
      />
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
          <Card className="setup-step">
            <CardHeader>
              <CardTitle>
                <h2>1. Repo</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className={rowClass}>
                <span className={labelClass}>Thư mục chứa repo</span>
                <code id="setup-parent-path" className="setup-path min-w-0 flex-1 truncate text-xs text-muted-foreground" title={parent}>
                  {parent ?? 'Chưa chọn'}
                </code>
                <Button id="setup-parent" variant="outline" disabled={busy} onClick={() => void pickParent()}>
                  {spinner('parent')}
                  Chọn…
                </Button>
              </div>
              <form id="setup-new-form" className={rowClass} onSubmit={createRepo}>
                <Label htmlFor="setup-new-name" className={labelClass}>
                  Tạo repo mới
                </Label>
                <Input
                  id="setup-new-name"
                  className="min-w-0 flex-1"
                  placeholder="Tên thư mục, ví dụ du-an-abc"
                  value={newName}
                  onChange={(event) => setNewName(event.currentTarget.value)}
                />
                <Button id="setup-new-create" type="submit" disabled={busy}>
                  {spinner('create')}
                  Tạo repo
                </Button>
              </form>
              <form id="setup-clone-form" className={rowClass} onSubmit={cloneRepo}>
                <Label htmlFor="setup-clone-url" className={labelClass}>
                  Clone từ URL
                </Label>
                <Input
                  id="setup-clone-url"
                  className="min-w-0 flex-1"
                  placeholder="https://github.com/<tổ chức>/<repo>.git"
                  value={cloneUrl}
                  onChange={(event) => {
                    const url = event.currentTarget.value;
                    setCloneUrl(url);
                    if (nameFollowsUrl) setCloneName(repoName(url));
                  }}
                />
                <Input
                  id="setup-clone-name"
                  className="setup-name w-40"
                  placeholder="Tên thư mục"
                  aria-label="Tên thư mục của bản clone"
                  value={cloneName}
                  onChange={(event) => {
                    const name = event.currentTarget.value;
                    setCloneName(name);
                    setNameFollowsUrl(name === '');
                  }}
                />
                <Button id="setup-clone-go" type="submit" variant="outline" disabled={busy}>
                  {spinner('clone')}
                  Clone
                </Button>
              </form>
              <div className={rowClass}>
                <span className={labelClass}>Repo có sẵn</span>
                <Button id="setup-open" variant="outline" disabled={busy} onClick={() => void withRunning('open', async () => useRepo(await api.openRepo()))}>
                  {spinner('open')}
                  Mở repo có sẵn…
                </Button>
              </div>
              <div id="setup-repo-result" className="setup-result break-words" aria-live="polite">
                <OutcomeView outcome={repoResult} />
              </div>
            </CardContent>
          </Card>

          <Card className="setup-step">
            <CardHeader>
              <CardTitle>
                <h2>2. Cài Taigent vào repo</h2>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <StatusView />
              <div className="flex flex-wrap gap-2">
                <Button id="setup-init" disabled={busy || !repo || !status} onClick={() => void runInit()}>
                  {spinner('init')}
                  {status?.state === 'none' || !status ? 'Cài Taigent vào repo' : 'Chạy lại init'}
                </Button>
              </div>
              <div id="setup-init-result" className="setup-result" aria-live="polite">
                {initResult &&
                  ('pending' in initResult ? (
                    <p className="text-muted-foreground">Đang chạy taigent init…</p>
                  ) : initResult.ok ? (
                    <InitTable report={initResult.value} />
                  ) : (
                    <FailureBlock failure={initResult} />
                  ))}
              </div>
            </CardContent>
          </Card>

          <Card className="setup-step">
            <CardHeader>
              <CardTitle>
                <h2>3. npm install</h2>
              </CardTitle>
              <CardDescription>
                Cài <Code>taigent</Code> (devDependency mà bước 2 ghim theo version của ứng dụng) vào <Code>node_modules/</Code>, nơi agent chạy MCP
                server <Code>taiga</Code>. Cần Node.js 24+ trên máy.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Button id="setup-npm" variant="outline" disabled={busy || !repo} onClick={() => void runNpmInstall()}>
                  Chạy npm install trong terminal
                </Button>
              </div>
              <p id="setup-npm-result" className="text-muted-foreground empty:hidden" aria-live="polite">
                {npmResult}
              </p>
            </CardContent>
          </Card>
        </div>

        <aside className="min-w-0">
          <Card className="panel">
            <CardHeader>
              <CardTitle>
                <h2>4. Kiểm tra</h2>
              </CardTitle>
              <CardAction>
                <Button id="setup-recheck" variant="outline" size="sm" disabled={toolsChecking || loginChecking} onClick={() => void checkTools()}>
                  {(toolsChecking || loginChecking) && <Spinner aria-hidden="true" />}
                  Kiểm tra lại
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ul id="setup-checklist" className="setup-checklist divide-y" aria-live="polite">
                {SETUP_TOOLS.map((tool) => (
                  <ToolItem key={tool} tool={tool} check={toolsChecking ? undefined : tools?.find((entry) => entry.tool === tool)} onInstall={(t) => void runInstall(t)} />
                ))}
                <LoginItem checking={loginChecking} />
                <ChecklistItem item="mcp" state="reminder" mark="warn">
                  Lần đầu mở <Code>claude</Code> trong repo, Claude Code hỏi có dùng MCP server <Code>taiga</Code> (khai báo trong <Code>.mcp.json</Code>)
                  không: hãy chọn dùng, để agent đọc được Taiga. Kiểm tra lại bằng <Code>claude mcp get taiga</Code>. Codex chỉ nạp{' '}
                  <Code>.codex/config.toml</Code> của repo khi bạn trust project.
                </ChecklistItem>
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>
    </ScreenBody>
  );
}

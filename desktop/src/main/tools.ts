// The setup checklist's tool detection: each tool is looked up on PATH and its `--version` runs through execFile,
// never a shell, under a timeout the app enforces itself. On Windows a global npm package is a `.cmd` shim, which
// only a shell can run: the shim npm writes (cmd-shim) names the script it hands to node, so that script runs with
// node directly. Any other `.cmd` is reported as found without a version. The app never installs a tool: it only
// shows each one's install command and runs it in a terminal tab when the user asks.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { SETUP_TOOLS, type SetupTool, type ToolCheck } from '../shared/api.ts';

/** How long a tool gets to answer `--version`. */
const VERSION_TIMEOUT_MS = 10_000;

const windows = process.platform === 'win32';

/** The command that installs each tool; it runs only in a terminal tab the user opens (`installTool`). */
export const INSTALL_COMMANDS: Record<SetupTool, string> = windows
  ? {
      git: 'winget install --id Git.Git -e',
      claude: 'irm https://claude.ai/install.ps1 | iex',
      codex: 'npm install -g @openai/codex',
      omp: 'irm https://omp.sh/install.ps1 | iex',
    }
  : {
      git: 'xcode-select --install',
      claude: 'curl -fsSL https://claude.ai/install.sh | bash',
      codex: 'npm install -g @openai/codex',
      omp: 'curl -fsSL https://omp.sh/install | sh',
    };

const isFile = (path: string): Promise<boolean> => stat(path).then((info) => info.isFile(), () => false);

/** `name` on PATH: on Windows the first of `.com`, `.exe`, `.bat`, `.cmd` (the order Windows tries them) in each folder. */
async function findOnPath(name: string): Promise<string | undefined> {
  const extensions = windows ? ['.com', '.exe', '.bat', '.cmd'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const folder = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!folder) continue;
    for (const extension of extensions) {
      const path = join(folder, name + extension);
      const found = windows ? await isFile(path) : await access(path, constants.X_OK).then(() => isFile(path), () => false);
      if (found) return path;
    }
  }
  return undefined;
}

/**
 * What a `.cmd` shim written by npm (cmd-shim) runs: its program (`node`, or `<shim dir>\node.exe`) and script, or a
 * native `.exe` it calls; undefined for any other batch file.
 */
async function shimTarget(path: string): Promise<{ file: string; args: string[] } | undefined> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const dir = dirname(path);
  const script = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/i.exec(text)?.[1];
  if (script) {
    const program = /SET "_prog=([^"%\\/]+)"/i.exec(text)?.[1] ?? 'node';
    const local = join(dir, `${program}.exe`);
    const interpreter = (await isFile(local)) ? local : await findOnPath(program);
    return interpreter ? { file: interpreter, args: [join(dir, script)] } : undefined;
  }
  const native = /"%dp0%\\([^"]+\.exe)"\s+%\*/i.exec(text)?.[1];
  return native ? { file: join(dir, native), args: [] } : undefined;
}

/** The version in a `--version` line (`git version 2.47.1.windows.2` → 2.47.1), else the line itself. */
function versionOf(line: string): string {
  return /\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/.exec(line)?.[0] ?? line;
}

/** Runs `<file> <args> --version` without a shell; settles by the timeout even when the tool never exits. */
function runVersion(tool: SetupTool, path: string, file: string, args: string[]): Promise<ToolCheck> {
  const base = { tool, path, install: INSTALL_COMMANDS[tool] };
  const { promise, resolve } = Promise.withResolvers<ToolCheck>();
  let settled = false;
  const settle = (check: ToolCheck): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(check);
  };
  const child = execFile(file, [...args, '--version'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.trim() ?? '';
    if (error) {
      settle({ ...base, state: 'error', message: firstLine(stderr) || firstLine(stdout) || error.message });
      return;
    }
    const line = firstLine(stdout) || firstLine(stderr);
    settle(line ? { ...base, state: 'ok', version: versionOf(line) } : { ...base, state: 'error', message: '`--version` không in gì.' });
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle({ ...base, state: 'timeout', message: `\`${tool} --version\` không trả lời sau ${VERSION_TIMEOUT_MS / 1000} giây.` });
  }, VERSION_TIMEOUT_MS);
  return promise;
}

async function checkTool(tool: SetupTool): Promise<ToolCheck> {
  const install = INSTALL_COMMANDS[tool];
  const path = await findOnPath(tool);
  if (!path) return { tool, state: 'missing', install };
  if (windows && /\.(cmd|bat)$/i.test(path)) {
    const target = await shimTarget(path);
    if (!target) return { tool, path, state: 'found', install, message: 'Có trên PATH, nhưng không đọc được version mà không chạy qua shell.' };
    return runVersion(tool, path, target.file, target.args);
  }
  return runVersion(tool, path, path, []);
}

/** Every tool of the checklist, checked at the same time. */
export function checkTools(): Promise<ToolCheck[]> {
  return Promise.all(SETUP_TOOLS.map(checkTool));
}

/** Whether git is on PATH, before the wizard creates or clones anything. */
export async function hasGit(): Promise<boolean> {
  return (await findOnPath('git')) !== undefined;
}

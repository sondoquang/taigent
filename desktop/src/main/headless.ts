// The headless buttons (Plan backlog từ spec, Nhờ agent xử lý góp ý, Tạo user story): each opens a `skill` tab of the
// terminal running taigent's own `tools/taiga/run-skill` (bundled with the app) in the opened repository, so the run
// uses that repository's skills and the allowlist `taigent init` installed there, exactly like run-skill outside the
// app. The buttons only run `taiga-plan-backlog` and `taiga-create-user-story`, never apply, upload or bootstrap, and
// the run gets TAIGENT_READ_ONLY=1, which the agent's shell and every `taigent` it starts inherit: the CLI then refuses
// every command that writes to Taiga (exit 2), so the run's writes wait for the app's own buttons. The views refresh
// through the project watcher as the agent edits taiga/<slug>/; the end of a run (exit code, cancelled, last error
// line) goes to the renderer. TAIGENT_RUN_SKILL_DRY_RUN=1 passes `--dry-run`: the tab prints the command.

import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { type BrowserWindow, dialog } from 'electron';
import type { Failure, Result, SkillRun, SkillRunAction, SkillRunEnd, SkillRunRequest } from '../shared/api.ts';
import { failure } from './project.ts';
import { slugFailure } from './ipc.ts';
import { headlessAgent, projectDir } from './repo.ts';
import { taigentRoot } from './taigent.ts';
import { type TerminalCommand, terminals } from './terminal.ts';

const SKILLS: Record<SkillRunAction, string> = {
  'plan-spec': 'taiga-plan-backlog',
  review: 'taiga-plan-backlog',
  story: 'taiga-create-user-story',
};

const TITLES: Record<SkillRunAction, string> = {
  'plan-spec': 'Plan backlog',
  review: 'Xử lý góp ý',
  story: 'Tạo user story',
};

/** Appended to every request: a headless run has nobody to answer, and its writes to Taiga wait for the app. */
const HEADLESS_NOTE = 'Chạy headless từ Taigent Desktop: không chờ ai trả lời, chỉ sửa file trong repo, không chạy apply, upload hay bootstrap.';

/** Output kept to find the last error line. */
const OUTPUT_TAIL = 64 * 1024;

// CSI, OSC and two-character escape sequences: the pty's colours and cursor moves.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const ERROR_LINE = /error|lỗi|fail|denied|not found|not recognized|exception|run-skill:/i;

/** The last line of `output` that reads as an error, else its last line. */
export function lastErrorLine(output: string): string | undefined {
  const lines = output
    .replace(ANSI, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.findLast((line) => ERROR_LINE.test(line)) ?? lines.at(-1);
}

/**
 * Text that goes into the agent's prompt: one line, no double quote (Windows PowerShell 5.1 mangles it in arguments
 * of native programs, docs/headless.md) and no control character.
 */
function promptText(raw: unknown, what: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error(`${what} đang trống.`);
  if (text.length > 1000) throw new Error(`${what} dài quá 1000 ký tự.`);
  if (/["\p{Cc}]/u.test(text)) throw new Error(`${what} không được chứa dấu ngoặc kép (") hay xuống dòng.`);
  return text;
}

/** A project of the opened repository, named by the renderer: `taiga/<slug>/` must exist. */
async function projectSlug(root: string, raw: unknown): Promise<string> {
  const slug = typeof raw === 'string' ? raw : '';
  const exists = slugFailure(slug) === undefined && (await stat(projectDir(root, slug)).then((info) => info.isDirectory(), () => false));
  if (!exists) throw new Error(`Không có dự án ${slug || '(trống)'} trong repo.`);
  return slug;
}

/** The spec file the user picks, as the prompt names it: repo-relative with `/`, or absolute outside the repo. */
async function pickSpec(root: string, window: BrowserWindow): Promise<string | undefined> {
  const picked = await dialog.showOpenDialog(window, {
    title: 'Chọn file spec',
    defaultPath: root,
    properties: ['openFile'],
    filters: [
      { name: 'Spec', extensions: ['md', 'markdown', 'txt'] },
      { name: 'Mọi file', extensions: ['*'] },
    ],
  });
  const file = picked.canceled ? undefined : picked.filePaths[0];
  if (!file) return undefined;
  const inside = relative(root, file);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : file;
}

/** The skill arguments of a run: what to do, then the headless note. */
async function skillRequest(root: string, request: SkillRunRequest, window: BrowserWindow): Promise<string | undefined> {
  if (request.action === 'plan-spec') {
    const spec = await pickSpec(root, window);
    if (spec === undefined) return undefined;
    const project = request.slug === undefined ? '' : ` Project: ${await projectSlug(root, request.slug)}.`;
    return `Spec: ${promptText(spec, 'Đường dẫn spec')}.${project} ${HEADLESS_NOTE}`;
  }
  const slug = await projectSlug(root, request.slug);
  if (request.action === 'review') return `Xử lý các góp ý còn mở trong review.yaml của project ${slug}. ${HEADLESS_NOTE}`;
  const description = promptText(request.description, 'Mô tả user story');
  return `${description} Project: ${slug}. Tự chọn persona và epic phù hợp nhất, ghi story vào backlog.yaml rồi dừng ở bước hỏi xác nhận. ${HEADLESS_NOTE}`;
}

/** A PowerShell single-quoted literal; PowerShell also reads the typographic single quotes as quotes. */
function psQuote(text: string): string {
  return `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}

/**
 * The bundled run-skill with `args`, without a shell of the user's: Windows PowerShell (switched to UTF-8 output first,
 * like the terminal's shells) on Windows, /bin/sh elsewhere.
 */
function runSkillCommand(args: string[]): TerminalCommand {
  const scripts = join(taigentRoot(), 'tools', 'taiga');
  if (process.platform !== 'win32') return { file: '/bin/sh', args: [join(scripts, 'run-skill.sh'), ...args] };
  const call = [join(scripts, 'run-skill.ps1'), ...args].map(psQuote).join(' ');
  return {
    file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ${call}; exit $LASTEXITCODE`,
    ],
  };
}

let running: SkillRun | undefined;

/** One run at a time: two agents editing backlog.yaml together would undo each other's work. */
function busy(): Failure | undefined {
  return running && failure(`Đang chạy ${TITLES[running.action]} (${running.agent}). Chờ lần chạy đó xong hoặc bấm Huỷ trong tab của nó.`);
}

/** The fields are checked where they are used: the slug against the repository, the texts by `promptText`. */
function isRequest(value: unknown): value is SkillRunRequest {
  return typeof value === 'object' && value !== null && 'action' in value && Object.hasOwn(SKILLS, String(value.action));
}

/**
 * Starts one run in a new `skill` tab (Huỷ kills its process tree); `ended` gets its end. Undefined when the spec
 * dialog is cancelled.
 */
export async function runSkill(root: string, request: unknown, window: BrowserWindow, ended: (end: SkillRunEnd) => void): Promise<Result<SkillRun> | undefined> {
  const refused = busy();
  if (refused) return refused;
  if (!isRequest(request)) return failure('Yêu cầu chạy skill không hợp lệ.');
  let prompt: string | undefined;
  try {
    prompt = await skillRequest(root, request, window);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
  if (prompt === undefined) return undefined;
  const agent = await headlessAgent();
  // Checked again: another run may have started while the spec dialog was open.
  const started = busy();
  if (started) return started;
  const skill = SKILLS[request.action];
  const dryRun = process.env.TAIGENT_RUN_SKILL_DRY_RUN === '1' ? ['--dry-run'] : [];
  const handle = terminals.open({
    kind: 'skill',
    cwd: root,
    title: `${TITLES[request.action]} · ${agent}`,
    command: { ...runSkillCommand([...dryRun, '--output-format', 'text', agent, skill, prompt]), env: { TAIGENT_READ_ONLY: '1' } },
  });
  const run: SkillRun = { action: request.action, agent, skill, tabId: handle.tab.id };
  running = run;
  let output = '';
  const stop = handle.onData((data) => {
    output = (output + data).slice(-OUTPUT_TAIL);
  });
  void handle.exited.then((exit) => {
    stop();
    running = undefined;
    const end: SkillRunEnd = { ...run, exitCode: exit.exitCode, cancelled: exit.cancelled };
    const line = exit.exitCode === 0 || exit.cancelled ? undefined : lastErrorLine(output);
    ended(line ? { ...end, lastErrorLine: line } : end);
  });
  return { ok: true, value: run };
}

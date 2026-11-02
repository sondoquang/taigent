// The headless buttons of the Backlog section (Plan backlog từ spec, Nhờ agent xử lý góp ý, Tạo user story) and the
// Settings choice of their agent. A run opens a `skill` tab in the terminal panel (main process: src/main/headless.ts,
// the bundled run-skill); its end shows here with the exit code and, on failure, the last error line. The tree, the
// forms and the review follow the agent's edits through the project watcher; `refresh` re-reads the repository too,
// for a project the run created.

import { HEADLESS_AGENTS, type HeadlessAgent, type ProjectView, type RepoInfo, type SkillRunAction, type SkillRunEnd, type SkillRunRequest, type TaigentApi } from '../shared/api.ts';
import { byId } from './dom.ts';

export interface HeadlessHost {
  api: TaigentApi;
  repo(): RepoInfo | undefined;
  view(): ProjectView | undefined;
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Re-reads the repository and the open project once a run has ended. */
  refresh(): Promise<void>;
}

const LABELS: Record<SkillRunAction, string> = {
  'plan-spec': 'Plan backlog từ spec',
  review: 'Xử lý góp ý',
  story: 'Tạo user story',
};

let host: HeadlessHost | undefined;
let agent: HeadlessAgent = 'claude';
let running: SkillRunAction | undefined;

function setStatus(state: 'running' | 'ok' | 'error' | 'cancelled', text: string): void {
  const status = byId('agent-status');
  status.dataset.state = state;
  status.textContent = text;
  status.title = text;
}

/** Enables the buttons for what is open: a repository for a spec, a project for the review and a story; none while a run goes on. */
export function renderHeadless(): void {
  if (!host) return;
  const idle = running === undefined;
  byId<HTMLButtonElement>('agent-plan-spec').disabled = !idle || !host.repo();
  byId<HTMLButtonElement>('agent-review').disabled = !idle || !host.view();
  byId<HTMLButtonElement>('agent-story').disabled = !idle || !host.view();
  byId('agent-name').textContent = agent;
}

async function start(request: SkillRunRequest): Promise<void> {
  if (!host || running) return;
  const label = LABELS[request.action];
  running = request.action;
  renderHeadless();
  const result = await host.api.runSkill(request);
  if (!result?.ok) {
    running = undefined;
    renderHeadless();
    if (result) {
      setStatus('error', `${label}: không chạy được. ${result.message}`);
      host.toast(result.message, 'error');
    }
    return;
  }
  // A short run (`--dry-run`) may have ended before this reply arrived.
  if (running !== undefined) setStatus('running', `Đang chạy ${label} (${result.value.agent}) trong tab terminal…`);
}

function ended(end: SkillRunEnd): void {
  if (!host) return;
  running = undefined;
  renderHeadless();
  const label = LABELS[end.action];
  if (end.cancelled) {
    setStatus('cancelled', `${label} (${end.agent}): đã huỷ.`);
    host.toast(`Đã huỷ ${label}.`);
  } else if (end.exitCode === 0) {
    setStatus('ok', `${label} (${end.agent}): xong, mã thoát 0.`);
    host.toast(`${label}: xong.`);
  } else {
    const line = end.lastErrorLine ? ` ${end.lastErrorLine}` : '';
    setStatus('error', `${label} (${end.agent}): lỗi, mã thoát ${end.exitCode}.${line}`);
    host.toast(`${label}: lỗi, mã thoát ${end.exitCode}.`, 'error');
  }
  void host.refresh();
}

function openStoryDialog(): void {
  const input = byId<HTMLInputElement>('story-description');
  input.value = '';
  byId('story-error').hidden = true;
  byId<HTMLDialogElement>('story-dialog').showModal();
  input.focus();
}

function submitStory(event: Event): void {
  event.preventDefault();
  const description = byId<HTMLInputElement>('story-description').value.trim();
  const error = byId('story-error');
  const slug = host?.view()?.slug;
  if (!description || !slug) return;
  if (/["\r\n]/.test(description)) {
    error.textContent = 'Không dùng dấu ngoặc kép (") trong mô tả.';
    error.hidden = false;
    return;
  }
  byId<HTMLDialogElement>('story-dialog').close();
  void start({ action: 'story', slug, description });
}

function showAgent(): void {
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="headless-agent"]')) radio.checked = radio.value === agent;
  renderHeadless();
}

async function chooseAgent(choice: string): Promise<void> {
  if (!host) return;
  const picked = HEADLESS_AGENTS.find((known) => known === choice);
  if (!picked) return;
  const result = await host.api.setHeadlessAgent(picked);
  if (result.ok) {
    agent = result.value;
    host.toast(`Nút chạy skill dùng ${agent}.`);
  } else host.toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
  showAgent();
}

export function mountHeadless(headlessHost: HeadlessHost): void {
  host = headlessHost;
  const { api } = headlessHost;
  byId('agent-plan-spec').addEventListener('click', () => {
    const slug = host?.view()?.slug;
    void start(slug ? { action: 'plan-spec', slug } : { action: 'plan-spec' });
  });
  byId('agent-review').addEventListener('click', () => {
    const slug = host?.view()?.slug;
    if (slug) void start({ action: 'review', slug });
  });
  byId('agent-story').addEventListener('click', openStoryDialog);
  byId('story-dialog-form').addEventListener('submit', submitStory);
  byId('story-cancel').addEventListener('click', () => byId<HTMLDialogElement>('story-dialog').close());
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="headless-agent"]')) {
    radio.addEventListener('change', () => void chooseAgent(radio.value));
  }
  api.onSkillRunEnded(ended);
  void api.headlessAgent().then((stored) => {
    agent = stored;
    showAgent();
  });
  renderHeadless();
}

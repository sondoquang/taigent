// Actions shared by the screens: feedback (toast, result dialog), the repository and project they show, the Backlog
// selection and the Taiga login. They read and write the store outside React, so callbacks never see stale state.

import type { ReactNode } from 'react';
import { toast as sonner } from 'sonner';
import { type Failure, HEADLESS_AGENTS, type ProjectView, type RepoInfo, type Result, ROLES } from '../shared/api.ts';
import { api, findNode, type Filter, ROLE_LABEL, type Section, useApp, visibleNodes } from './store.ts';

/** A short confirmation (3 s) or an error (8 s); both are announced by the toaster's live region. */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  if (kind === 'error') sonner.error(message, { duration: 8000 });
  else sonner(message, { duration: 3000 });
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'ok' in value && value.ok === false && 'message' in value;
}

/** Opens the result dialog with `content`, or with a failure block for `failure`. */
export function showResult(title: string, content: ReactNode | Failure): void {
  useApp.setState({ result: isFailure(content) ? { title, failure: content } : { title, content: content as ReactNode } });
}

export function closeResult(): void {
  useApp.setState({ result: undefined });
}

export function showSection(section: Section): void {
  useApp.setState({ section });
}

export function setFilter(filter: Filter): void {
  useApp.setState({ filter });
}

export function select(key: string): void {
  useApp.setState({ selected: key });
}

/** Moves the Backlog selection one visible row down (1) or up (-1). */
export function move(step: 1 | -1): void {
  const { view, filter, selected } = useApp.getState();
  if (!view) return;
  const nodes = visibleNodes(view, filter);
  if (nodes.length === 0) return;
  const index = nodes.findIndex((node) => node.item.key === selected);
  const next = nodes[Math.min(nodes.length - 1, Math.max(0, index === -1 ? 0 : index + step))];
  if (next) select(next.item.key);
}

/** Shows a new view of the open project, keeping the selection when the item still exists (or selecting `key`). */
export function applyView(result: Result<ProjectView>, key?: string): void {
  if (!result.ok) {
    showResult('Không đọc được dự án', result);
    return;
  }
  const wanted = key ?? useApp.getState().selected;
  const selected = findNode(result.value, wanted) ? wanted : visibleNodes(result.value, 'all')[0]?.item.key;
  useApp.setState({ view: result.value, selected });
}

/** Opens project `slug` of the repository ('' closes it). */
export async function openProject(slug: string): Promise<void> {
  if (!slug) {
    useApp.setState({ view: undefined, selected: undefined });
    return;
  }
  useApp.setState({ selected: undefined });
  applyView(await api.openProject(slug));
}

/** A repository the folder dialog or the setup wizard opened; its only project opens at once. */
export function useRepo(result: Result<RepoInfo> | undefined): void {
  if (!result) return;
  if (!result.ok) {
    showResult('Không mở được thư mục', result);
    return;
  }
  useApp.setState({ repo: result.value, view: undefined, selected: undefined });
  const only = result.value.projects.length === 1 ? result.value.projects[0] : undefined;
  if (only) void openProject(only.slug);
}

/** Reads the repository again (a project.yaml or backlog.yaml written since), keeping what is open. */
export async function refreshRepo(): Promise<void> {
  const repo = await api.refreshRepo();
  if (repo.ok) useApp.setState({ repo: repo.value });
}

/** Reads the repository and the open project again; opens the repository's only project when none is open. */
export async function refreshProject(): Promise<void> {
  await refreshRepo();
  const { view, repo } = useApp.getState();
  const only = repo?.projects.length === 1 ? repo.projects[0] : undefined;
  if (view) applyView(await api.openProject(view.slug));
  else if (only) await openProject(only.slug);
}

export async function refreshLogin(): Promise<void> {
  useApp.setState({ login: await api.whoami() });
}

/** Runs `fn` with the busy flag on (a `taigent plan` or `apply`). */
export async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  useApp.setState({ busy: true });
  try {
    return await fn();
  } finally {
    useApp.setState({ busy: false });
  }
}

/** The login button and the setup checklist: the login dialog, or the logout confirmation when logged in. */
export function openLogin(): void {
  useApp.setState({ account: useApp.getState().login?.loggedIn ? 'logout' : 'login' });
}

export function closeAccount(): void {
  useApp.setState({ account: undefined });
}

/** The agent of the headless skill buttons, saved in settings.json (Backlog agent bar and Settings both pick it). */
export async function chooseHeadlessAgent(choice: string): Promise<void> {
  const picked = HEADLESS_AGENTS.find((known) => known === choice);
  if (!picked) return;
  const result = await api.setHeadlessAgent(picked);
  if (result.ok) {
    useApp.setState({ headlessAgent: result.value });
    toast(`Nút chạy skill dùng ${result.value}.`);
  } else toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
}

/** The Dashboard's Role, saved in settings.json (the Dashboard's first-run choice, its menu and Settings all pick it). */
export async function chooseRole(choice: string): Promise<void> {
  const picked = ROLES.find((known) => known === choice);
  if (!picked) return;
  const result = await api.setRole(picked);
  if (result.ok) {
    useApp.setState({ role: result.value });
    toast(`Dashboard hiện theo vai trò ${ROLE_LABEL[result.value]}.`);
  } else toast([result.message, result.detail].filter(Boolean).join(': '), 'error');
}

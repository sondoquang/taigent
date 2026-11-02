// One project's review: the preview the renderer shows, the verdicts and comments written to review.yaml, the
// live watch of `taiga/<slug>/`, and the checks before pushing to Taiga.

import { type FSWatcher, watch } from 'node:fs';
import { join } from 'node:path';
import type {
  BacklogSnapshot,
  Failure,
  ManifestIssue,
  Preview,
  PreviewItem,
  ProjectView,
  RemoveItemRequest,
  RemoveOutcome,
  Result,
  SaveItemRequest,
  SaveOutcome,
  Validation,
  VerdictChoice,
} from '../shared/api.ts';
import { projectDir, reviewerName } from './repo.ts';
import { loadCore, parseCliJson, runCli } from './taigent.ts';

const WATCH_DEBOUNCE_MS = 250;

export function failure(message: string, extra: Omit<Failure, 'ok' | 'message'> = {}): Failure {
  return { ok: false, message, ...extra };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A thrown error as a Failure: a ManifestError keeps its issues. */
export function toFailure(error: unknown, message = 'Không đọc được backlog'): Failure {
  const detail = messageOf(error);
  if (error && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)) {
    // ManifestError (src/manifest/errors.ts): issues are `{ file, path, rule, message }`.
    const issues = error.issues as ManifestIssue[];
    return failure(`${message}: manifest không hợp lệ`, { detail, issues });
  }
  return failure(message, { detail });
}

export async function validate(root: string, slug: string): Promise<Validation> {
  const run = await runCli(['validate', '--project', slug, '--json'], root);
  if (run.code === 0) return { valid: true, issues: [] };
  const { error } = parseCliJson(run);
  return { valid: false, issues: error?.issues ?? [], error: error?.message };
}

export async function buildView(root: string, slug: string): Promise<Result<ProjectView>> {
  const { review } = await loadCore();
  let preview: Preview;
  try {
    preview = await review.buildPreview(projectDir(root, slug), slug);
  } catch (error) {
    return toFailure(error);
  }
  const [validation, reviewer] = await Promise.all([validate(root, slug), reviewerName(root)]);
  return { ok: true, value: { slug, preview, validation, reviewer } };
}

export function allItems(preview: Preview): PreviewItem[] {
  return [...preview.epics.flatMap((epic) => [epic, ...epic.stories.flatMap((story) => [story, ...story.tasks])]), ...preview.issues];
}

// review.yaml writes run one at a time, so two quick clicks never read the same old file.
let writes: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => undefined);
  return next;
}

type Change = { kind: 'verdict'; verdict: VerdictChoice } | { kind: 'comment'; text: string };

export function changeReview(root: string, slug: string, key: string, change: Change): Promise<Result<ProjectView>> {
  return serialized(async () => {
    const { review } = await loadCore();
    const dir = projectDir(root, slug);
    try {
      const preview = await review.buildPreview(dir, slug);
      const item = allItems(preview).find((candidate) => candidate.key === key);
      if (!item) return failure(`Không còn mục ${key} trong backlog (agent vừa đổi hoặc xoá?)`);
      const by = await reviewerName(root);
      const at = new Date().toISOString();
      const path = join(dir, review.REVIEW_FILE);
      const current = await review.loadReview(path);
      const next =
        change.kind === 'verdict'
          ? review.setVerdict(current, key, change.verdict === 'clear' ? undefined : change.verdict, item.digest, by, at)
          : review.addComment(current, key, change.text, by, at);
      await review.saveReview(path, next);
    } catch (error) {
      return toFailure(error, 'Không ghi được review.yaml');
    }
    return buildView(root, slug);
  });
}

// ---- Forms: the manifest edit API (src/edit.ts) ---------------------------------------------------

export async function readBacklog(root: string, slug: string): Promise<Result<BacklogSnapshot>> {
  const { edit, project } = await loadCore();
  const dir = projectDir(root, slug);
  try {
    const file = await edit.readManifestFile(dir, 'backlog');
    const manifest = await project.loadProject(join(dir, project.PROJECT_FILE), slug).catch(() => undefined);
    return { ok: true, value: { file, attributes: manifest?.customAttributes ?? { epic: [], story: [], task: [], issue: [] } } };
  } catch (error) {
    return toFailure(error);
  }
}

/**
 * Moves (`to` set) or drops the reviews of re-keyed or removed items: review.yaml may only name keys of the backlog
 * (rule `key-reference`). The edit API never touches review.yaml; the app does, as it does for verdicts.
 */
async function rekeyReviews(dir: string, keys: Record<string, string | undefined>): Promise<void> {
  const { review } = await loadCore();
  const path = join(dir, review.REVIEW_FILE);
  const current = await review.loadReview(path);
  const items = { ...current.items };
  let changed = false;
  for (const [from, to] of Object.entries(keys)) {
    const entry = items[from];
    if (!entry) continue;
    delete items[from];
    if (to !== undefined) items[to] = entry;
    changed = true;
  }
  if (changed) await review.saveReview(path, { items });
}

export function saveItem(root: string, slug: string, request: SaveItemRequest): Promise<Result<SaveOutcome>> {
  return serialized(async () => {
    const { edit } = await loadCore();
    const dir = projectDir(root, slug);
    try {
      const result = await edit.saveItem(dir, request);
      if (result.status !== 'saved') return { ok: true, value: result };
      if (request.original !== undefined && request.original !== request.item.key) await rekeyReviews(dir, { [request.original]: request.item.key });
      return { ok: true, value: { ...result, view: await buildView(root, slug) } };
    } catch (error) {
      return toFailure(error, 'Không lưu được backlog.yaml');
    }
  });
}

export function removeItem(root: string, slug: string, request: RemoveItemRequest): Promise<Result<RemoveOutcome>> {
  return serialized(async () => {
    const { edit } = await loadCore();
    const dir = projectDir(root, slug);
    try {
      const result = await edit.removeItem(dir, request);
      if (result.status !== 'saved') return { ok: true, value: result };
      await rekeyReviews(dir, Object.fromEntries(result.removed.map((key) => [key, undefined])));
      return { ok: true, value: { ...result, view: await buildView(root, slug) } };
    } catch (error) {
      return toFailure(error, 'Không xoá được mục khỏi backlog.yaml');
    }
  });
}

/** Watches one project folder; every change (an agent editing backlog.yaml, review.yaml…) rebuilds the view. */
export class ProjectWatcher {
  #watcher: FSWatcher | undefined;
  #timer: NodeJS.Timeout | undefined;

  watch(root: string, slug: string, onChange: (view: Result<ProjectView>) => void): void {
    this.close();
    try {
      this.#watcher = watch(projectDir(root, slug), () => {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void buildView(root, slug).then(onChange), WATCH_DEBOUNCE_MS);
      });
      this.#watcher.on('error', () => this.close());
    } catch {
      this.#watcher = undefined;
    }
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#watcher = undefined;
  }
}

/** Why the project cannot be pushed now: invalid manifests, or items marked "Cần sửa" with open comments. */
export function pushBlockers(view: ProjectView): string[] {
  const reasons: string[] = [];
  if (!view.validation.valid) {
    reasons.push(`Manifest chưa hợp lệ (${view.validation.issues.length || 1} lỗi): sửa rồi chạy lại \`taigent validate\`.`);
  }
  const waiting = allItems(view.preview).filter((item) => item.review.verdict === 'changes' && item.review.openComments > 0);
  if (waiting.length > 0) {
    reasons.push(`${waiting.length} mục "Cần sửa" còn góp ý chưa xử lý: ${waiting.map((item) => item.key).join(', ')}.`);
  }
  return reasons;
}

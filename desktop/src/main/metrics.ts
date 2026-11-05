// Dashboard: the metrics of the open repository's project, read with `taigent metrics` (read-only, ADR 0003). Each
// successful read is saved as `<userData>/metrics-cache/latest-<slug>-<instance>.json`, keyed like the CLI's history
// cache by the Taiga API URL the user is logged in to (the renderer's `whoami`), so the Dashboard shows the last
// numbers of that Taiga with their `generatedAt` at once while the next read runs. The same folder is the CLI's history
// cache (`--cache-dir`, its own `history-*.json` files), so a refresh reads Taiga's history again only for changed items.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { Failure, MetricsReport, Result } from '../shared/api.ts';
import { failure } from './project.ts';
import { networkFix, taigaFailure } from './taiga-errors.ts';
import { type CliError, loadCore, parseCliJson, runCli } from './taigent.ts';

/** The shape of the saved read; a file of another version is ignored (bump when MetricsReport changes shape). */
const SAVED_VERSION = 1;

interface SavedMetrics {
  version: number;
  apiUrl: string;
  report: MetricsReport;
}

/** The app's metrics folder: the last read of each project, and the CLI's history cache. */
function cacheDir(): string {
  return join(app.getPath('userData'), 'metrics-cache');
}

/** `latest-<slug>-<first 16 hex of sha256(apiUrl)>.json`: one saved read per project and Taiga instance. */
function latestFile(slug: string, apiUrl: string): string {
  const instance = createHash('sha256').update(apiUrl).digest('hex').slice(0, 16);
  return join(cacheDir(), `latest-${slug}-${instance}.json`);
}

/** The arguments of one `taigent metrics` run: the only place the Dashboard's command line is built. */
function metricsArgs(slug: string): string[] {
  return ['metrics', '--project', slug, '--cache-dir', cacheDir(), '--json'];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A Failure unless `apiUrl` is the API URL of the user's login (a non-empty string) or absent (no login). */
export function apiUrlFailure(apiUrl: unknown): Failure | undefined {
  if (apiUrl === undefined || (typeof apiUrl === 'string' && apiUrl.trim() !== '')) return undefined;
  return failure(`"${String(apiUrl)}" không phải URL API Taiga.`);
}

/**
 * The last saved read of `slug` on the Taiga at `apiUrl`; null without a login (no `apiUrl`), without one, or when the
 * file is of another version, Taiga or project, or lacks a section a dashboard shows.
 */
export async function cachedMetrics(slug: string, apiUrl: string | undefined): Promise<MetricsReport | null> {
  if (apiUrl === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(latestFile(slug, apiUrl), 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.version !== SAVED_VERSION || parsed.apiUrl !== apiUrl || !isObject(parsed.report)) return null;
  const report = parsed.report;
  const valid =
    typeof report.generatedAt === 'string' &&
    isObject(report.project) &&
    report.project.slug === slug &&
    isObject(report.developer) &&
    isObject(report.productOwner) &&
    isObject(report.businessAnalyst) &&
    Array.isArray(report.periods);
  return valid ? (report as unknown as MetricsReport) : null;
}

async function saveLatest(slug: string, apiUrl: string, report: MetricsReport): Promise<void> {
  const { files } = await loadCore();
  await mkdir(cacheDir(), { recursive: true });
  const saved: SavedMetrics = { version: SAVED_VERSION, apiUrl, report };
  // A unique temporary file renamed over it: a crash never leaves half a file, and overlapping reads never share one.
  await files.writeAtomic(latestFile(slug, apiUrl), `${JSON.stringify(saved)}\n`);
}

function metricsFailure(error: CliError | undefined, slug: string): Failure {
  if (error?.kind === 'project') {
    return failure(
      `Project ${slug} không có trên Taiga, hoặc tài khoản đang đăng nhập không xem được nó. ` +
        'Cách sửa: tạo project ở mục Taiga > Project (Bootstrap), hoặc nhờ admin thêm bạn vào project, rồi bấm Làm mới.',
      { detail: error.message },
    );
  }
  if (error?.kind === 'validation') {
    return failure(
      `Manifest của dự án (taiga/${slug}/project.yaml) không hợp lệ, nên chưa đọc được số liệu. ` +
        `Cách sửa: chạy taigent validate --project ${slug}, sửa các lỗi nó báo, rồi bấm Làm mới.`,
      { detail: error.message, issues: error.issues },
    );
  }
  return taigaFailure(error, { failed: `Không đọc được số liệu của ${slug} từ Taiga. ${networkFix()}` });
}

/**
 * `taigent metrics --project <slug> --json` in `root` (its .env applies); a success replaces the saved read of the Taiga
 * at `apiUrl` (none is saved without a login).
 */
export async function readMetrics(root: string, slug: string, apiUrl: string | undefined): Promise<Result<MetricsReport>> {
  const { value, error } = parseCliJson<MetricsReport>(await runCli(metricsArgs(slug), root));
  if (!value) return metricsFailure(error, slug);
  if (apiUrl !== undefined) {
    try {
      await saveLatest(slug, apiUrl, value);
    } catch {
      // The numbers are shown anyway; only the instant display at the next start is lost.
    }
  }
  return { ok: true, value };
}

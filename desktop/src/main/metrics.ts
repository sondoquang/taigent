// Dashboard: the metrics of the open repository's project, read with `taigent metrics` (read-only, ADR 0003). Each
// successful read is saved as `<userData>/metrics-cache/latest-<slug>.json`, so the Dashboard shows the last numbers
// with their `generatedAt` at once while the next read runs. The same folder is the CLI's history cache
// (`--cache-dir`, its own `history-*.json` files), so a refresh reads Taiga's history again only for changed items.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import type { Failure, MetricsReport, Result } from '../shared/api.ts';
import { failure } from './project.ts';
import { networkFix, taigaFailure } from './taiga-errors.ts';
import { type CliError, parseCliJson, runCli } from './taigent.ts';

/** The app's metrics folder: the last read of each project, and the CLI's history cache. */
function cacheDir(): string {
  return join(app.getPath('userData'), 'metrics-cache');
}

function latestFile(slug: string): string {
  return join(cacheDir(), `latest-${slug}.json`);
}

/** The arguments of one `taigent metrics` run: the only place the Dashboard's command line is built. */
function metricsArgs(slug: string): string[] {
  return ['metrics', '--project', slug, '--cache-dir', cacheDir(), '--json'];
}

/** The last saved read of `slug`; null without one, or when the file is not a metrics read of that project. */
export async function cachedMetrics(slug: string): Promise<MetricsReport | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(latestFile(slug), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const report = parsed as Partial<MetricsReport>;
    const valid = typeof report.generatedAt === 'string' && report.project?.slug === slug && typeof report.developer === 'object' && Array.isArray(report.periods);
    return valid ? (report as MetricsReport) : null;
  } catch {
    return null;
  }
}

async function saveLatest(slug: string, report: MetricsReport): Promise<void> {
  await mkdir(cacheDir(), { recursive: true });
  const file = latestFile(slug);
  // Written aside then renamed, so a crash never leaves half a file for the next start to show.
  await writeFile(`${file}.tmp`, `${JSON.stringify(report)}\n`);
  await rename(`${file}.tmp`, file);
}

function metricsFailure(error: CliError | undefined, slug: string): Failure {
  if (error?.kind === 'project') {
    return failure(
      `Project ${slug} không có trên Taiga, hoặc tài khoản đang đăng nhập không xem được nó. ` +
        'Cách sửa: tạo project ở mục Taiga > Project (Bootstrap), hoặc nhờ admin thêm bạn vào project, rồi bấm Làm mới.',
      { detail: error.message },
    );
  }
  return taigaFailure(error, { failed: `Không đọc được số liệu của ${slug} từ Taiga. ${networkFix()}` });
}

/** `taigent metrics --project <slug> --json` in `root` (its .env applies); a success replaces the saved read. */
export async function readMetrics(root: string, slug: string): Promise<Result<MetricsReport>> {
  const { value, error } = parseCliJson<MetricsReport>(await runCli(metricsArgs(slug), root));
  if (!value) return metricsFailure(error, slug);
  try {
    await saveLatest(slug, value);
  } catch {
    // The numbers are shown anyway; only the instant display at the next start is lost.
  }
  return { ok: true, value };
}

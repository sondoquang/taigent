// Taiga > Báo cáo: one project's progress by sprint and by epic, read with `taigent report --project <slug> --json`.

import type { ProjectReport, Result } from '../shared/api.ts';
import { failure } from './project.ts';
import { SLUG } from './taiga-projects.ts';
import { parseCliJson, runCli } from './taigent.ts';

export async function readTaigaReport(root: string, slug: string): Promise<Result<ProjectReport>> {
  if (!SLUG.test(slug)) return failure(`"${slug}" không phải slug project.`);
  const { value, error } = parseCliJson<ProjectReport>(await runCli(['report', '--project', slug, '--json'], root));
  if (value) return { ok: true, value };
  if (error?.kind === 'login') return failure('Chưa đăng nhập Taiga: đăng nhập để xem báo cáo.');
  return failure(`Không đọc được báo cáo của ${slug} từ Taiga.`, { detail: error?.message });
}

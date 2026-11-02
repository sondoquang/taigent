// Taiga > Báo cáo: one project's progress by sprint and by epic, read with `taigent report --project <slug> --json`.

import type { ProjectReport, Result } from '../shared/api.ts';
import { networkFix, taigaFailure } from './taiga-errors.ts';
import { parseCliJson, runCli } from './taigent.ts';

export async function readTaigaReport(root: string, slug: string): Promise<Result<ProjectReport>> {
  const { value, error } = parseCliJson<ProjectReport>(await runCli(['report', '--project', slug, '--json'], root));
  if (value) return { ok: true, value };
  const retry = 'Xem báo cáo';
  return taigaFailure(error, { failed: `Không đọc được báo cáo của ${slug} từ Taiga. ${networkFix(retry)}`, retry });
}

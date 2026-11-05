// The backlog manifest and review.yaml of a project as `taigent metrics` reads them: through the same preview as
// `taigent preview` and Taigent Desktop. Missing or invalid manifests do not fail the command; the metrics that need
// them become unavailable (business-analyst.ts).

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { isFileNotFound } from '../guards.ts';
import { BACKLOG_FILE } from '../manifest/backlog.ts';
import { ManifestError, type ManifestIssue } from '../manifest/errors.ts';
import { buildPreview, type Preview } from '../review.ts';

/** `missing`: no backlog manifest (`file`, its path). `invalid`: what `taigent validate` reports about the manifests. */
export type BacklogData =
  | { status: 'ok'; preview: Preview }
  | { status: 'missing'; file: string }
  | { status: 'invalid'; issues: ManifestIssue[] };

/** The preview of project `slug`'s manifests in `dir`, or why there is none. */
export async function readBacklogData(dir: string, slug: string): Promise<BacklogData> {
  const file = join(dir, BACKLOG_FILE);
  try {
    await access(file);
  } catch (error) {
    if (isFileNotFound(error)) return { status: 'missing', file };
    throw error;
  }
  try {
    return { status: 'ok', preview: await buildPreview(dir, slug) };
  } catch (error) {
    if (error instanceof ManifestError) return { status: 'invalid', issues: error.issues };
    throw error;
  }
}

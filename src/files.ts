// File helpers shared by the writers of manifests, review.yaml (edit API, project settings, review) and setup: the
// SHA-256 digest a form reads and a later write is checked against, and the atomic write (temporary file + rename).

import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** SHA-256 (hex) of `text`. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A temporary file next to `path`, `.<name>.<uuid>.tmp`: unique per call, so concurrent writers never share one. */
export function temporaryPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
}

/** Writes `content` to `path` atomically: a temporary file next to it, renamed over it (removed when the write fails). */
export async function writeAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

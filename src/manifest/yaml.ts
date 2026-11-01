import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { errorMessage, isFileNotFound } from '../guards.ts';
import { ManifestError } from './errors.ts';

/** Reads and parses a YAML manifest (empty file → `{}`); a missing file or bad syntax is a ManifestError. */
export async function readManifestYaml(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    throw new ManifestError([{ file: path, path: '', rule: 'file-exists', message: 'manifest file not found' }]);
  }
  try {
    return parse(text) ?? {};
  } catch (error) {
    throw new ManifestError([{ file: path, path: '', rule: 'yaml-syntax', message: errorMessage(error) }]);
  }
}

// Manifest module: loads and validates `taiga/<slug>/backlog.yaml`. No network I/O.

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { isRecord } from '../guards.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';

export const BACKLOG_FILE = 'backlog.yaml';

/** Stable item keys: uppercase letters/digits in dash-separated groups, e.g. `AUTH-LOGIN`. */
export const KEY_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export interface EpicSpec {
  key: string;
  subject: string;
  description: string;
  tags: string[];
}

export interface Backlog {
  epics: EpicSpec[];
}

const EPIC_FIELDS: Record<string, true> = { key: true, subject: true, description: true, tags: true };

/** Reads and validates the backlog manifest at `path`; throws ManifestError listing every issue. */
export async function loadBacklog(path: string): Promise<Backlog> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new ManifestError([{ file: path, path: '', rule: 'file-exists', message: 'manifest file not found' }]);
  }

  let doc: unknown;
  try {
    doc = parse(text) ?? {};
  } catch (error) {
    throw new ManifestError([{ file: path, path: '', rule: 'yaml-syntax', message: (error as Error).message }]);
  }

  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });

  if (!isRecord(doc)) {
    issue('', 'type', 'backlog must be a mapping with an `epics` list');
    throw new ManifestError(issues);
  }
  const rawEpics = doc.epics ?? [];
  if (!Array.isArray(rawEpics)) {
    issue('epics', 'type', 'must be a list');
    throw new ManifestError(issues);
  }

  const epics: EpicSpec[] = [];
  const seenKeys = new Map<string, string>();
  rawEpics.forEach((raw: unknown, index) => {
    const at = `epics[${index}]`;
    if (!isRecord(raw)) {
      issue(at, 'type', 'epic must be a mapping');
      return;
    }
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(EPIC_FIELDS, field)) issue(`${at}.${field}`, 'known-field', `unknown epic field \`${field}\``);
    }
    const { key, subject, description = '', tags = [] } = raw;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      issue(`${at}.key`, 'key-format', `key is required and must match ${KEY_PATTERN} (e.g. AUTH-LOGIN)`);
    } else if (seenKeys.has(key)) {
      issue(`${at}.key`, 'key-unique', `duplicate key ${key} (first used at ${seenKeys.get(key)})`);
    } else {
      seenKeys.set(key, `${at}.key`);
    }
    if (typeof subject !== 'string' || subject.trim() === '') issue(`${at}.subject`, 'required', 'subject is required');
    if (typeof description !== 'string') issue(`${at}.description`, 'type', 'must be a string');
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string' && tag !== '')) {
      issue(`${at}.tags`, 'type', 'must be a list of non-empty strings');
    }
    epics.push({ key, subject, description, tags } as EpicSpec);
  });

  if (issues.length > 0) throw new ManifestError(issues);
  return { epics };
}

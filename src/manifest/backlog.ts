// Manifest module: loads and validates `taiga/<slug>/backlog.yaml`. No network I/O.

import { isRecord } from '../guards.ts';
import { checkKey, checkTag } from './conventions.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import { readManifestYaml } from './yaml.ts';

export const BACKLOG_FILE = 'backlog.yaml';

export interface EpicSpec {
  key: string;
  subject: string;
  description: string;
  tags: string[];
}

export interface Backlog {
  epics: EpicSpec[];
}

/** Every item key declared in the backlog (epics, stories and tasks). */
export function backlogKeys(backlog: Backlog): Set<string> {
  return new Set(backlog.epics.map((epic) => epic.key));
}

const EPIC_FIELDS: Record<string, true> = { key: true, subject: true, description: true, tags: true };

/** Reads and validates the backlog manifest at `path`; throws ManifestError listing every issue. */
export async function loadBacklog(path: string): Promise<Backlog> {
  const doc = await readManifestYaml(path);

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
    checkKey(key, `${at}.key`, issue, seenKeys);
    if (typeof subject !== 'string' || subject.trim() === '') issue(`${at}.subject`, 'required', 'subject is required');
    if (typeof description !== 'string') issue(`${at}.description`, 'type', 'must be a string');
    if (!Array.isArray(tags)) issue(`${at}.tags`, 'type', 'must be a list of tags');
    else tags.forEach((tag: unknown, i) => checkTag(tag, `${at}.tags[${i}]`, issue));
    epics.push({ key, subject, description, tags } as EpicSpec);
  });

  if (issues.length > 0) throw new ManifestError(issues);
  return { epics };
}

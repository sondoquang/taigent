// Skills: the Taigent skills (every `taiga-*` skill plus `ask-taigent`) have one source, `.agents/skills/` (read by
// Codex). `.claude/skills/` holds byte-identical copies for Claude Code; `taigent init` copies both from the running
// package into another repository. Only Taigent skill directories are compared or written; other skills (e.g. the
// vendored mattpocock ones) are never touched.

import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isFileNotFound } from './guards.ts';

const SKILL_PREFIX = 'taiga-';
/** Taigent skills whose names lack the `taiga-` prefix. */
const UNPREFIXED_SKILLS: readonly string[] = ['ask-taigent'];

/** Canonical skills directory, relative to the repository root. */
export const SKILLS_SOURCE = '.agents/skills';
/** Generated copy for Claude Code, relative to the repository root. */
export const SKILLS_TARGET = '.claude/skills';

export interface SkillDifference {
  skill: string;
  /** Path inside the skill directory, `/`-separated. */
  file: string;
  /** `missing`: only in the source; `changed`: contents differ; `extra`: only in the Claude copy. */
  status: 'missing' | 'changed' | 'extra';
}

/** One file of a Taigent skill, compared; `same`: identical in both directories. */
export interface SkillFile {
  skill: string;
  /** Path inside the skill directory, `/`-separated. */
  file: string;
  status: SkillDifference['status'] | 'same';
}

export interface SkillDirsComparison {
  /** Taigent skills of the source directory, sorted. */
  skills: string[];
  /** Every file of every Taigent skill of either directory. */
  files: SkillFile[];
}

export interface SkillsComparison {
  inSync: boolean;
  /** Taigent skills of the source, sorted. */
  skills: string[];
  differences: SkillDifference[];
}

export interface SkillsSyncReport {
  skills: string[];
  /** Skills copied over because their Claude copy was missing or different. */
  synced: string[];
  /** Claude copies removed because their skill is gone from the source. */
  removed: string[];
}

/** The source skills directory does not exist under the given root. */
export class SkillsSourceMissingError extends Error {}

/** Taigent skill directory names under `dir` (empty when `dir` does not exist). */
async function listSkills(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && (entry.name.startsWith(SKILL_PREFIX) || UNPREFIXED_SKILLS.includes(entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

/** Files under `dir`, as sorted `/`-separated relative paths (empty when `dir` does not exist). */
async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replaceAll('\\', '/'))
      .sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

/** Every file of `skill` in `sourceDir` or `targetDir`, compared. */
async function compareSkill(skill: string, sourceDir: string, targetDir: string): Promise<SkillFile[]> {
  const [sourceFiles, targetFiles] = await Promise.all([listFiles(join(sourceDir, skill)), listFiles(join(targetDir, skill))]);
  const files: SkillFile[] = [];
  for (const file of sourceFiles) {
    if (!targetFiles.includes(file)) {
      files.push({ skill, file, status: 'missing' });
      continue;
    }
    const [source, target] = await Promise.all([readFile(join(sourceDir, skill, file)), readFile(join(targetDir, skill, file))]);
    files.push({ skill, file, status: source.equals(target) ? 'same' : 'changed' });
  }
  for (const file of targetFiles) {
    if (!sourceFiles.includes(file)) files.push({ skill, file, status: 'extra' });
  }
  return files;
}

/** Compares every Taigent skill of `sourceDir` with its copy in `targetDir`, file by file (either may be absent). */
export async function compareSkillDirs(sourceDir: string, targetDir: string): Promise<SkillDirsComparison> {
  const [skills, targetSkills] = await Promise.all([listSkills(sourceDir), listSkills(targetDir)]);
  const names = [...new Set([...skills, ...targetSkills])].sort();
  const files = (await Promise.all(names.map((skill) => compareSkill(skill, sourceDir, targetDir)))).flat();
  return { skills, files };
}

/**
 * Makes every Taigent skill of `targetDir` identical to `sourceDir`, from their comparison: skills with a difference
 * are replaced, skills gone from the source are removed. Other skills are never touched.
 */
export async function copySkills(sourceDir: string, targetDir: string, comparison: SkillDirsComparison): Promise<Omit<SkillsSyncReport, 'skills'>> {
  const outOfSync = [...new Set(comparison.files.filter(({ status }) => status !== 'same').map(({ skill }) => skill))];
  const synced = outOfSync.filter((skill) => comparison.skills.includes(skill));
  const removed = outOfSync.filter((skill) => !comparison.skills.includes(skill));
  for (const skill of outOfSync) await rm(join(targetDir, skill), { recursive: true, force: true });
  for (const skill of synced) await cp(join(sourceDir, skill), join(targetDir, skill), { recursive: true });
  return { synced, removed };
}

/** `compareSkillDirs` of `<root>/.agents/skills` and `<root>/.claude/skills`; the source must exist. */
async function compareRoot(root: string): Promise<SkillDirsComparison> {
  try {
    await readdir(join(root, SKILLS_SOURCE));
  } catch (error) {
    if (isFileNotFound(error)) throw new SkillsSourceMissingError(`no ${SKILLS_SOURCE} directory in ${root}; run from the repository root`);
    throw error;
  }
  return compareSkillDirs(join(root, SKILLS_SOURCE), join(root, SKILLS_TARGET));
}

/** Compares every Taigent skill of `<root>/.agents/skills` with its copy in `<root>/.claude/skills`. */
export async function compareSkills(root: string): Promise<SkillsComparison> {
  const { skills, files } = await compareRoot(root);
  const differences = files.filter((file): file is SkillDifference => file.status !== 'same');
  return { inSync: differences.length === 0, skills, differences };
}

/**
 * Makes every Taigent skill of `<root>/.claude/skills` identical to `<root>/.agents/skills`: out-of-date copies are
 * replaced, copies of skills gone from the source are removed.
 */
export async function syncSkills(root: string): Promise<SkillsSyncReport> {
  const comparison = await compareRoot(root);
  return { skills: comparison.skills, ...(await copySkills(join(root, SKILLS_SOURCE), join(root, SKILLS_TARGET), comparison)) };
}

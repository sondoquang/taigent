// Skills: the taiga-* Agent Skills have one source, `.agents/skills/` (read by Codex). `.claude/skills/` holds
// byte-identical copies for Claude Code. Only `taiga-*` directories are compared or written; other skills
// (e.g. the vendored mattpocock ones) are never touched.

import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isFileNotFound } from './guards.ts';

export const SKILL_PREFIX = 'taiga-';
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

export interface SkillsComparison {
  inSync: boolean;
  /** taiga-* skills of the source, sorted. */
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

/** taiga-* skill directory names under `dir` (empty when `dir` does not exist). */
async function listSkills(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX)).map((entry) => entry.name).sort();
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

async function compareSkill(skill: string, sourceDir: string, targetDir: string): Promise<SkillDifference[]> {
  const [sourceFiles, targetFiles] = await Promise.all([listFiles(join(sourceDir, skill)), listFiles(join(targetDir, skill))]);
  const differences: SkillDifference[] = [];
  for (const file of sourceFiles) {
    if (!targetFiles.includes(file)) {
      differences.push({ skill, file, status: 'missing' });
      continue;
    }
    const [source, target] = await Promise.all([readFile(join(sourceDir, skill, file)), readFile(join(targetDir, skill, file))]);
    if (!source.equals(target)) differences.push({ skill, file, status: 'changed' });
  }
  for (const file of targetFiles) {
    if (!sourceFiles.includes(file)) differences.push({ skill, file, status: 'extra' });
  }
  return differences;
}

/** Compares every taiga-* skill of `<root>/.agents/skills` with its copy in `<root>/.claude/skills`. */
export async function compareSkills(root: string): Promise<SkillsComparison> {
  const sourceDir = join(root, SKILLS_SOURCE);
  const targetDir = join(root, SKILLS_TARGET);
  try {
    await readdir(sourceDir);
  } catch (error) {
    if (isFileNotFound(error)) throw new SkillsSourceMissingError(`no ${SKILLS_SOURCE} directory in ${root}; run from the repository root`);
    throw error;
  }
  const [skills, targetSkills] = await Promise.all([listSkills(sourceDir), listSkills(targetDir)]);
  const names = [...new Set([...skills, ...targetSkills])].sort();
  const differences = (await Promise.all(names.map((skill) => compareSkill(skill, sourceDir, targetDir)))).flat();
  return { inSync: differences.length === 0, skills, differences };
}

/**
 * Makes `<root>/.claude/skills/taiga-*` identical to `<root>/.agents/skills/taiga-*`: out-of-date copies are
 * replaced, copies of skills gone from the source are removed.
 */
export async function syncSkills(root: string): Promise<SkillsSyncReport> {
  const comparison = await compareSkills(root);
  const outOfSync = [...new Set(comparison.differences.map((difference) => difference.skill))];
  const synced = outOfSync.filter((skill) => comparison.skills.includes(skill));
  const removed = outOfSync.filter((skill) => !comparison.skills.includes(skill));
  for (const skill of outOfSync) await rm(join(root, SKILLS_TARGET, skill), { recursive: true, force: true });
  for (const skill of synced) await cp(join(root, SKILLS_SOURCE, skill), join(root, SKILLS_TARGET, skill), { recursive: true });
  return { skills: comparison.skills, synced, removed };
}

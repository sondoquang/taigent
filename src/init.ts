// Init: installs into a repository everything Taigent needs, taken from the running taigent package: the Taigent
// skills (.agents/skills and the .claude/skills copy), the `taiga` MCP server entries (.mcp.json, .codex/config.toml),
// the headless kit, the `.gitignore` lines of the local copies (BA preview, snapshot) and the `taigent` devDependency pinned to
// this version's git tag. Offline; never runs npm or logs in. Only Taigent's own files and entries are written: other
// skills, servers, keys, ignore lines and dependencies stay as they are.

import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { errorMessage, isFileNotFound, isRecord } from './guards.ts';
import { compareSkillDirs, copySkills, type SkillFile, SKILLS_SOURCE, SKILLS_TARGET } from './skills.ts';

/** Root of the running taigent package (the repository, or `node_modules/taigent`): `src/` and `dist/` sit in it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files of the headless kit, at the same path in the package and in the repository: `run-skill` reads the allowlist,
 * loads the OMP guard extension and runs the Codex shell guard from the repository root, both guards read
 * `tools/taiga/allowlist.txt` (the OMP one also runs the Codex shell guard), and Codex loads execpolicy rules from
 * `.codex/rules/`.
 */
const HEADLESS_KIT: readonly string[] = ['tools/taiga/allowlist.txt', 'tools/taiga/omp-guard.mjs', '.codex/hooks/taigent-shell-guard.mjs', '.codex/rules/taigent.rules'];

/** The `taiga` server of `.mcp.json`: `taigent mcp`, run from the installed package. */
const MCP_ENTRY = { command: 'node', args: ['node_modules/taigent/bin/taigent.js', 'mcp'] };

/** The `taiga` server of `.codex/config.toml`. Codex passes a stdio server only a few variables; env_vars forwards the ones taigent may need. */
const CODEX_TABLE = `[mcp_servers.taiga]
command = "node"
args = ["node_modules/taigent/bin/taigent.js", "mcp"]
env_vars = ["TAIGA_API_URL", "TAIGA_USERNAME", "TAIGA_PASSWORD", "TAIGA_TOKEN", "TAIGENT_CONFIG_DIR", "TAIGENT_CREDENTIAL_STORE", "XDG_CONFIG_HOME", "DBUS_SESSION_BUS_ADDRESS"]
required = true
`;
const CODEX_ENTRY = (parseToml(CODEX_TABLE).mcp_servers as Record<string, unknown>).taiga;
const CODEX_HEADER = `# Project-scoped Codex config (loaded only when this project is trusted).
# No secrets here: \`taigent mcp\` uses the login stored by \`npx taigent login\`. env_vars only forwards variables
# you set yourself (TAIGA_* on a CI machine; where the stored login lives; Linux's Secret Service session bus).
`;

const TAIGA_TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:taiga|"taiga"|'taiga')\s*\]\s*(?:#.*)?$/;
const TAIGA_SUBTABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:taiga|"taiga"|'taiga')\s*\./;

/**
 * `.gitignore` lines of the local copies: the BA preview working copies (`taiga-apply-backlog` carries their edits into
 * `backlog.yaml`) and the snapshot of `taigent snapshot`. An older install gets the lines it lacks on the next init.
 */
const GITIGNORE_COMMENT = '# Taigent: local copies, never committed (the BA preview, whose edits taiga-apply-backlog carries into backlog.yaml; the snapshot of taigent snapshot)';
const GITIGNORE_LINES: readonly string[] = ['taiga/*/preview.md', 'taiga/*/.preview/', 'taiga/*/snapshot.json'];

export type InitStatus = 'created' | 'updated' | 'unchanged' | 'removed';

export interface InitFile {
  /** Relative to the repository root, `/`-separated. */
  path: string;
  status: InitStatus;
}

export interface InitReport {
  /** Every file init wrote, would write (dry run), removed or found up to date, sorted by path. */
  files: InitFile[];
}

/** A file init cannot merge into (not JSON/TOML, or not the expected shape), or the wrong directory. Nothing is written. */
export class InitError extends Error {}

const SKILL_STATUS: Record<SkillFile['status'], InitStatus> = { missing: 'created', changed: 'updated', extra: 'removed', same: 'unchanged' };

/** The `devDependencies` value of `taigent`: the git tag of the running version. */
async function taigentDependency(): Promise<string> {
  const { version } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  return `github:sondoquang/taigent#v${version}`;
}

/** The bytes of `path`, or undefined when there is no such file. */
async function readExisting(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

/** `text` parsed as a JSON object, or an InitError naming `file`. */
function parseJsonObject(file: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InitError(`cannot merge into ${file}: not valid JSON (${errorMessage(error)}); fix it, then run init again`);
  }
  if (!isRecord(value)) throw new InitError(`cannot merge into ${file}: not a JSON object`);
  return value;
}

/** The object field `key` of `object` (undefined when absent), or an InitError naming `file`. */
function objectField(file: string, object: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = object[key];
  if (value !== undefined && !isRecord(value)) throw new InitError(`cannot merge into ${file}: "${key}" is not an object`);
  return value;
}

/** `value` as JSON written like `original`: same indentation, line ending and final line break. */
function stringifyLike(original: string, value: unknown): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? 2;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(value, null, indent).replaceAll('\n', eol);
  return /\r?\n$/.test(original) ? `${text}${eol}` : text;
}

/** `.mcp.json` with the `taiga` server of MCP_ENTRY, other servers and keys unchanged; `text` itself when it is already there. */
function mergeMcpJson(text: string | undefined): string {
  if (text === undefined) return `${JSON.stringify({ mcpServers: { taiga: MCP_ENTRY } }, null, 2)}\n`;
  const config = parseJsonObject('.mcp.json', text);
  const servers = objectField('.mcp.json', config, 'mcpServers');
  if (isDeepStrictEqual(servers?.taiga, MCP_ENTRY)) return text;
  config.mcpServers = { ...servers, taiga: MCP_ENTRY };
  return stringifyLike(text, config);
}

/** `package.json` with `taigent` in devDependencies at `dependency` (moved out of dependencies), other fields unchanged. */
function mergePackageJson(text: string | undefined, dependency: string): string {
  if (text === undefined) return `${JSON.stringify({ devDependencies: { taigent: dependency } }, null, 2)}\n`;
  const pkg = parseJsonObject('package.json', text);
  const devDependencies = objectField('package.json', pkg, 'devDependencies');
  const dependencies = objectField('package.json', pkg, 'dependencies');
  if (devDependencies?.taigent === dependency && dependencies?.taigent === undefined) return text;
  if (dependencies) delete dependencies.taigent;
  pkg.devDependencies = { ...devDependencies, taigent: dependency };
  return stringifyLike(text, pkg);
}

/** `.gitignore` with the GITIGNORE_LINES it lacks appended under GITIGNORE_COMMENT; `text` itself when it has them all. */
function mergeGitignore(text: string | undefined): string {
  // Git ignores trailing spaces of a pattern, not leading ones.
  const present = new Set((text ?? '').split(/\r?\n/).map((line) => line.trimEnd()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (text !== undefined && missing.length === 0) return text;
  const eol = text?.includes('\r\n') ? '\r\n' : '\n';
  const block = [GITIGNORE_COMMENT, ...missing].join(eol) + eol;
  if (!text) return block;
  return `${text}${/\r?\n$/.test(text) ? '' : eol}${eol}${block}`;
}

function parseCodexToml(text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch (error) {
    throw new InitError(`cannot merge into .codex/config.toml: not valid TOML (${errorMessage(error)}); fix it, then run init again`);
  }
}

/** Indexes of the table header lines of `lines` (`[...]`, `[[...]]`), skipping lines inside multi-line strings. */
function tableHeaders(lines: string[]): number[] {
  const headers: number[] = [];
  let openString: string | undefined;
  lines.forEach((line, index) => {
    if (openString === undefined && /^\s*\[/.test(line)) headers.push(index);
    for (const [delimiter] of line.matchAll(/"""|'''/g)) {
      if (openString === undefined) openString = delimiter;
      else if (delimiter === openString) openString = undefined;
    }
  });
  return headers;
}

/**
 * `.codex/config.toml` with the `taiga` server of CODEX_TABLE: an existing `[mcp_servers.taiga]` table (and its
 * subtables) is replaced in place, else the table is appended. Every other line stays as it is; `text` itself when the
 * entry is already there. The result is parsed again before it is returned.
 */
function mergeCodexToml(text: string | undefined): string {
  if (text === undefined) return `${CODEX_HEADER}${CODEX_TABLE}`;
  const servers = parseCodexToml(text).mcp_servers;
  const current = isRecord(servers) ? servers.taiga : undefined;
  if (isDeepStrictEqual(current, CODEX_ENTRY)) return text;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const table = CODEX_TABLE.trimEnd().split('\n');
  const lines = text.split(/\r?\n/);
  const headers = tableHeaders(lines);
  const start = headers.find((index) => TAIGA_TABLE_HEADER.test(lines[index]!));
  let merged: string;
  if (start === undefined) {
    if (current !== undefined) {
      throw new InitError('cannot merge into .codex/config.toml: it defines mcp_servers.taiga other than as a [mcp_servers.taiga] table; remove that definition, then run init again');
    }
    const body = text.trimEnd();
    merged = `${body}${body === '' ? '' : `${eol}${eol}`}${table.join(eol)}${eol}`;
  } else {
    let end = headers.find((index) => index > start && !TAIGA_SUBTABLE_HEADER.test(lines[index]!)) ?? lines.length;
    // Blank lines and comments before the next table belong to it.
    while (end > start + 1 && /^\s*(?:#.*)?$/.test(lines[end - 1]!)) end--;
    merged = [...lines.slice(0, start), ...table, ...lines.slice(end)].join(eol);
  }
  let check: unknown;
  try {
    const mergedServers = parseToml(merged).mcp_servers;
    check = isRecord(mergedServers) ? mergedServers.taiga : undefined;
  } catch {
    check = undefined;
  }
  if (!isDeepStrictEqual(check, CODEX_ENTRY)) {
    throw new InitError('cannot merge into .codex/config.toml: the [mcp_servers.taiga] table could not be replaced safely; replace it by hand with the entry of docs/cli.md, then run init again');
  }
  return merged;
}

/**
 * Installs Taigent into the repository at `root` (with `dryRun`, only reports what it would do). Every file is read and
 * merged before the first write, so a file that cannot be merged leaves the repository untouched.
 */
export async function initRepository(root: string, { dryRun }: { dryRun: boolean }): Promise<InitReport> {
  if ((await realpath(root)) === (await realpath(PACKAGE_ROOT))) {
    throw new InitError('init installs taigent into another repository; this is the running taigent itself');
  }
  const files: InitFile[] = [];
  const writes: { path: string; content: string | Buffer }[] = [];
  const plan = async (path: string, content: string | Buffer) => {
    const current = await readExisting(join(root, path));
    if (current?.equals(Buffer.from(content))) {
      files.push({ path, status: 'unchanged' });
      return;
    }
    files.push({ path, status: current === undefined ? 'created' : 'updated' });
    writes.push({ path, content });
  };

  const skillsSource = join(PACKAGE_ROOT, SKILLS_SOURCE);
  const skillCopies = await Promise.all(
    [SKILLS_SOURCE, SKILLS_TARGET].map(async (dir) => ({ dir, comparison: await compareSkillDirs(skillsSource, join(root, dir)) })),
  );
  for (const { dir, comparison } of skillCopies) {
    for (const { skill, file, status } of comparison.files) files.push({ path: `${dir}/${skill}/${file}`, status: SKILL_STATUS[status] });
  }
  for (const path of HEADLESS_KIT) await plan(path, await readFile(join(PACKAGE_ROOT, path)));
  const text = async (path: string) => (await readExisting(join(root, path)))?.toString('utf8');
  await plan('.mcp.json', mergeMcpJson(await text('.mcp.json')));
  await plan('.codex/config.toml', mergeCodexToml(await text('.codex/config.toml')));
  await plan('package.json', mergePackageJson(await text('package.json'), await taigentDependency()));
  await plan('.gitignore', mergeGitignore(await text('.gitignore')));

  if (!dryRun) {
    for (const { dir, comparison } of skillCopies) await copySkills(skillsSource, join(root, dir), comparison);
    for (const { path, content } of writes) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files };
}

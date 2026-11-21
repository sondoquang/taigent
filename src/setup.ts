// Setup: installs Taigent from the running taigent package. `setupUser` (`taigent setup`) installs into the user config
// of every client found in the home directory (Claude Code, Codex, OMP) the Taigent skills and the `taiga` MCP server
// as the global `taigent mcp`. `setupProject` (`setup --project`) installs into a repository everything Taigent needs:
// the Taigent skills (.agents/skills and the .claude/skills copy), the `taiga` MCP server entries (.mcp.json,
// .codex/config.toml) run from node_modules, the headless kit, the `.gitignore` lines of the local copies (BA preview,
// snapshot) and the `taigent` devDependency pinned to this npm version. Offline; never runs npm or logs in. Only
// Taigent's own files and entries are written: other skills, servers, keys, ignore lines and dependencies stay as they
// are. Every file is read and merged before the first write (`FilePlan`), so a file that cannot be merged leaves
// everything untouched.

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { errorMessage, isFileNotFound, isRecord } from './guards.ts';
import { compareSkillDirs, copySkills, type SkillDirsComparison, type SkillFile, SKILLS_SOURCE, SKILLS_TARGET } from './skills.ts';

/** Root of the running taigent package (the repository, or `node_modules/taigent`): `src/` and `dist/` sit in it. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files of the headless kit, at the same path in the package and in the repository: `run-skill` reads the allowlist,
 * loads the OMP guard extension and runs the Codex shell guard from the repository root, both guards read
 * `tools/taiga/allowlist.txt` (the OMP one also runs the Codex shell guard), and Codex loads execpolicy rules from
 * `.codex/rules/`.
 */
const HEADLESS_KIT: readonly string[] = ['tools/taiga/allowlist.txt', 'tools/taiga/omp-guard.mjs', '.codex/hooks/taigent-shell-guard.mjs', '.codex/rules/taigent.rules'];

/**
 * The variables Codex forwards to the `taiga` server: Codex passes a stdio server only a few variables, so env_vars
 * names the ones taigent may need (TAIGA_* on a CI machine; where the stored login lives; Linux's Secret Service
 * session bus). Startup fails while the server is not ready (`required`).
 */
const CODEX_ENV_VARS = ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGA_TOKEN', 'TAIGENT_CONFIG_DIR', 'TAIGENT_CREDENTIAL_STORE', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS'];

/** The `taiga` server of one scope: its JSON entry (`mcpServers.taiga`) and its Codex table, with no secrets. */
interface McpServer {
  json: Record<string, unknown>;
  codex: { table: string; entry: unknown; header: string };
}

function mcpServer(json: { type?: string; command: string; args: string[] }, codexHeader: string): McpServer {
  const quote = (value: string) => JSON.stringify(value);
  const table = [
    '[mcp_servers.taiga]',
    `command = ${quote(json.command)}`,
    `args = [${json.args.map(quote).join(', ')}]`,
    `env_vars = [${CODEX_ENV_VARS.map(quote).join(', ')}]`,
    'required = true',
    '',
  ].join('\n');
  return { json, codex: { table, entry: (parseToml(table).mcp_servers as Record<string, unknown>).taiga, header: codexHeader } };
}

/** `setup --project`: `taigent mcp` run from the installed package, in `.mcp.json` and `.codex/config.toml`. */
const PROJECT_SERVER = mcpServer(
  { command: 'node', args: ['node_modules/taigent/bin/taigent.js', 'mcp'] },
  `# Project-scoped Codex config (loaded only when this project is trusted).
# No secrets here: \`taigent mcp\` uses the login stored by \`npx taigent login\`. env_vars only forwards variables
# you set yourself (TAIGA_* on a CI machine; where the stored login lives; Linux's Secret Service session bus).
`,
);

/** `taigent setup`: the global `taigent mcp` (`npm i -g taigent`), as the stdio server of each client's user config. */
const USER_SERVER = mcpServer(
  { type: 'stdio', command: 'taigent', args: ['mcp'] },
  `# No secrets here: \`taigent mcp\` uses the login stored by \`taigent login\`. env_vars only forwards variables
# you set yourself (TAIGA_* on a CI machine; where the stored login lives; Linux's Secret Service session bus).
`,
);

const TAIGA_TABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:taiga|"taiga"|'taiga')\s*\]\s*(?:#.*)?$/;
const TAIGA_SUBTABLE_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:taiga|"taiga"|'taiga')\s*\./;

/**
 * The clients `taigent setup` configures, all paths relative to the home directory. A client is there when one of its
 * `markers` is (a trailing `/`: a directory). OMP reads `~/.agents/skills` itself, so it shares Codex's copy.
 */
const USER_CLIENTS: readonly { name: string; markers: string[]; skills: string; mcp: string }[] = [
  { name: 'claude-code', markers: ['.claude/', '.claude.json'], skills: '.claude/skills', mcp: '.claude.json' },
  { name: 'codex', markers: ['.codex/'], skills: '.agents/skills', mcp: '.codex/config.toml' },
  { name: 'omp', markers: ['.omp/'], skills: '.agents/skills', mcp: '.omp/agent/mcp.json' },
];

/**
 * `.gitignore` lines of the local copies: the BA preview working copies (`taiga-apply-backlog` carries their edits into
 * `backlog.yaml`) and the snapshot of `taigent snapshot`. An older install gets the lines it lacks on the next setup.
 */
const GITIGNORE_COMMENT = '# Taigent: local copies, never committed (the BA preview, whose edits taiga-apply-backlog carries into backlog.yaml; the snapshot of taigent snapshot)';
const GITIGNORE_LINES: readonly string[] = ['taiga/*/preview.md', 'taiga/*/.preview/', 'taiga/*/snapshot.json'];

export type SetupStatus = 'created' | 'updated' | 'unchanged' | 'removed';

export interface SetupFile {
  /** `/`-separated; relative to the repository root (`setup --project`), or `~/...` under the home directory. */
  path: string;
  status: SetupStatus;
}

/** A client `taigent setup` configured (its user skills directory and MCP config, `~/...`), or skipped and why. */
export type SetupClient = { name: string; status: 'configured'; skills: string; mcp: string } | { name: string; status: 'skipped'; reason: string };

export interface SetupReport {
  /** Every file setup wrote, would write (dry run), removed or found up to date, sorted by path. */
  files: SetupFile[];
  /** `taigent setup` only: every client it knows, in a fixed order. */
  clients?: SetupClient[];
}

/** A file setup cannot merge into (not JSON/TOML, or not the expected shape), or the wrong directory. Nothing is written. */
export class SetupError extends Error {}

const SKILL_STATUS: Record<SkillFile['status'], SetupStatus> = { missing: 'created', changed: 'updated', extra: 'removed', same: 'unchanged' };

/** The `devDependencies` value of `taigent`: the npm version of the running taigent, pinned exactly. */
async function taigentDependency(): Promise<string> {
  const { version } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  return version;
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

/** `text` parsed as a JSON object, or a SetupError naming `file`. */
function parseJsonObject(file: string, text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SetupError(`cannot merge into ${file}: not valid JSON (${errorMessage(error)}); fix it, then run taigent setup again`);
  }
  if (!isRecord(value)) throw new SetupError(`cannot merge into ${file}: not a JSON object`);
  return value;
}

/** The object field `key` of `object` (undefined when absent), or a SetupError naming `file`. */
function objectField(file: string, object: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = object[key];
  if (value !== undefined && !isRecord(value)) throw new SetupError(`cannot merge into ${file}: "${key}" is not an object`);
  return value;
}

/** `value` as JSON written like `original`: same indentation, line ending and final line break. */
function stringifyLike(original: string, value: unknown): string {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? 2;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(value, null, indent).replaceAll('\n', eol);
  return /\r?\n$/.test(original) ? `${text}${eol}` : text;
}

/** JSON config `file` with the `taiga` server `entry` in `mcpServers`, other servers and keys unchanged; `text` itself when it is already there. */
function mergeMcpJson(file: string, text: string | undefined, entry: Record<string, unknown>): string {
  if (text === undefined) return `${JSON.stringify({ mcpServers: { taiga: entry } }, null, 2)}\n`;
  const config = parseJsonObject(file, text);
  const servers = objectField(file, config, 'mcpServers');
  if (isDeepStrictEqual(servers?.taiga, entry)) return text;
  config.mcpServers = { ...servers, taiga: entry };
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

function parseCodexToml(file: string, text: string): Record<string, unknown> {
  try {
    return parseToml(text);
  } catch (error) {
    throw new SetupError(`cannot merge into ${file}: not valid TOML (${errorMessage(error)}); fix it, then run taigent setup again`);
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
 * Codex config `file` with the `taiga` server of `codex`: an existing `[mcp_servers.taiga]` table (and its subtables)
 * is replaced in place, else the table is appended. Every other line stays as it is; `text` itself when the entry is
 * already there. The result is parsed again before it is returned.
 */
function mergeCodexToml(file: string, text: string | undefined, codex: McpServer['codex']): string {
  if (text === undefined) return `${codex.header}${codex.table}`;
  const servers = parseCodexToml(file, text).mcp_servers;
  const current = isRecord(servers) ? servers.taiga : undefined;
  if (isDeepStrictEqual(current, codex.entry)) return text;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const table = codex.table.trimEnd().split('\n');
  const lines = text.split(/\r?\n/);
  const headers = tableHeaders(lines);
  const start = headers.find((index) => TAIGA_TABLE_HEADER.test(lines[index]!));
  let merged: string;
  if (start === undefined) {
    if (current !== undefined) {
      throw new SetupError(`cannot merge into ${file}: it defines mcp_servers.taiga other than as a [mcp_servers.taiga] table; remove that definition, then run taigent setup again`);
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
  if (!isDeepStrictEqual(check, codex.entry)) {
    throw new SetupError(`cannot merge into ${file}: the [mcp_servers.taiga] table could not be replaced safely; replace it by hand with the entry of docs/cli.md, then run taigent setup again`);
  }
  return merged;
}

/**
 * The files one setup writes under `root`: each one is planned (compared with what is there) before any is written, so
 * a SetupError while planning leaves `root` untouched. The Taigent skill directories are planned whole. Reported
 * paths start with `shownRoot` (`~/` for the home directory).
 */
class FilePlan {
  readonly files: SetupFile[] = [];
  private readonly writes: { path: string; content: string | Buffer }[] = [];
  private readonly skillCopies: { dir: string; comparison: SkillDirsComparison }[] = [];

  private readonly root: string;
  private readonly shownRoot: string;

  constructor(root: string, shownRoot = '') {
    this.root = root;
    this.shownRoot = shownRoot;
  }

  /** Plans writing `content` to `path` (relative to the root, `/`-separated). */
  async file(path: string, content: string | Buffer): Promise<void> {
    const current = await readExisting(join(this.root, path));
    if (current?.equals(Buffer.from(content))) {
      this.files.push({ path: this.shownRoot + path, status: 'unchanged' });
      return;
    }
    this.files.push({ path: this.shownRoot + path, status: current === undefined ? 'created' : 'updated' });
    this.writes.push({ path, content });
  }

  /** Plans writing `path` as `merge` makes it from its text (undefined when absent) and its reported path. */
  async merge(path: string, merge: (text: string | undefined, file: string) => string): Promise<void> {
    const text = (await readExisting(join(this.root, path)))?.toString('utf8');
    await this.file(path, merge(text, this.shownRoot + path));
  }

  /** Plans copying the Taigent skills of the running taigent into `dir` (relative to the root). */
  async skills(dir: string): Promise<void> {
    const comparison = await compareSkillDirs(join(PACKAGE_ROOT, SKILLS_SOURCE), join(this.root, dir));
    this.skillCopies.push({ dir, comparison });
    for (const { skill, file, status } of comparison.files) this.files.push({ path: `${this.shownRoot}${dir}/${skill}/${file}`, status: SKILL_STATUS[status] });
  }

  /** Writes every planned change (unless `dryRun`) and returns the report. */
  async commit(dryRun: boolean): Promise<SetupReport> {
    if (!dryRun) {
      for (const { dir, comparison } of this.skillCopies) await copySkills(join(PACKAGE_ROOT, SKILLS_SOURCE), join(this.root, dir), comparison);
      for (const { path, content } of this.writes) {
        await mkdir(dirname(join(this.root, path)), { recursive: true });
        await writeFile(join(this.root, path), content);
      }
    }
    return { files: [...this.files].sort((a, b) => (a.path < b.path ? -1 : 1)) };
  }
}

/** Installs Taigent into the repository at `root` (`setup --project`; with `dryRun`, only reports what it would do). */
export async function setupProject(root: string, { dryRun }: { dryRun: boolean }): Promise<SetupReport> {
  if ((await realpath(root)) === (await realpath(PACKAGE_ROOT))) {
    throw new SetupError('setup --project installs taigent into another repository; this is the running taigent itself');
  }
  const plan = new FilePlan(root);
  for (const dir of [SKILLS_SOURCE, SKILLS_TARGET]) await plan.skills(dir);
  for (const path of HEADLESS_KIT) await plan.file(path, await readFile(join(PACKAGE_ROOT, path)));
  await plan.merge('.mcp.json', (text, file) => mergeMcpJson(file, text, PROJECT_SERVER.json));
  await plan.merge('.codex/config.toml', (text, file) => mergeCodexToml(file, text, PROJECT_SERVER.codex));
  const dependency = await taigentDependency();
  await plan.merge('package.json', (text) => mergePackageJson(text, dependency));
  await plan.merge('.gitignore', mergeGitignore);
  return plan.commit(dryRun);
}

/** Whether `path` under `home` exists: a directory when it ends in `/`. */
async function exists(home: string, path: string): Promise<boolean> {
  try {
    const stats = await stat(join(home, path));
    return path.endsWith('/') ? stats.isDirectory() : stats.isFile();
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

/**
 * Installs the Taigent skills and the `taiga` MCP server into the user config, under `home`, of every client found
 * there (`taigent setup`; with `dryRun`, only reports what it would do). A client that is not there is skipped: nothing
 * is created for it. A skills directory two clients share is written once.
 */
export async function setupUser(home: string, { dryRun }: { dryRun: boolean }): Promise<SetupReport> {
  const plan = new FilePlan(home, '~/');
  const clients: SetupClient[] = [];
  const skillDirs = new Set<string>();
  for (const { name, markers, skills, mcp } of USER_CLIENTS) {
    let found = false;
    for (const marker of markers) found ||= await exists(home, marker);
    if (!found) {
      clients.push({ name, status: 'skipped', reason: `not found: no ${markers.map((marker) => `~/${marker}`).join(' or ')}` });
      continue;
    }
    clients.push({ name, status: 'configured', skills: `~/${skills}`, mcp: `~/${mcp}` });
    if (!skillDirs.has(skills)) {
      skillDirs.add(skills);
      await plan.skills(skills);
    }
    await plan.merge(mcp, (text, file) => (mcp.endsWith('.toml') ? mergeCodexToml(file, text, USER_SERVER.codex) : mergeMcpJson(file, text, USER_SERVER.json)));
  }
  return { ...(await plan.commit(dryRun)), clients };
}

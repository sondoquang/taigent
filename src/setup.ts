// Setup: installs Taigent from the running taigent package. `setupUser` (`taigent setup`) installs into the user config
// of every client found in the home directory (Claude Code, Codex, OMP) the Taigent skills and the `taiga` MCP server
// as the global `taigent mcp`. `setupProject` (`setup --project`) installs into a repository everything Taigent needs:
// the Taigent skills (.agents/skills and the .claude/skills copy), the `taiga` MCP server entries (.mcp.json,
// .codex/config.toml) run from node_modules, the headless kit, the `.gitignore` lines of the local copies (BA preview,
// snapshot) and the `taigent` devDependency pinned to this npm version. Every skill it installs carries this version
// (`metadata.taigent-version`). Offline; never runs npm or logs in. Only Taigent's own files and entries are written:
// other skills, servers, keys, ignore lines and dependencies stay as they are. Every file is read and merged before the
// first write (`FilePlan`), so a file that cannot be merged leaves everything untouched. `checkInstall` then reports, for
// both scopes, the Taigent skills older than this taigent and the copies installed both for the user and in the
// working directory (with the one each client uses); it never removes anything.

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { errorMessage, isFileNotFound, isRecord } from './guards.ts';
import { compareSkillDirs, copySkills, listSkills, type SkillContent, type SkillDirsComparison, type SkillFile, SKILLS_SOURCE, SKILLS_TARGET, skillVersion, stampSkillVersion } from './skills.ts';

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

/** The copy a client uses when one is in the user config and one in the working directory; `both`: it shows both. */
export type DuplicateWinner = 'user' | 'project' | 'both';

/**
 * How a client ranks a project copy of a skill directory or MCP config against its user one: `project` lists the paths
 * (relative to the working directory) it reads, highest precedence first; `winner` names the copy it uses, given the
 * project path found, and the client's documented rule (sources in docs/cli.md §Setup: skill versions and duplicates).
 */
interface Precedence {
  project: string[];
  winner: (project: string) => { winner: DuplicateWinner; rule: string };
}

/**
 * The clients `taigent setup` configures, all paths relative to the home directory. A client is there when one of its
 * `markers` is (a trailing `/`: a directory). OMP reads `~/.agents/skills` itself, so it shares Codex's copy.
 */
const USER_CLIENTS: readonly { name: string; markers: string[]; skills: string; mcp: string; skillPrecedence: Precedence; mcpPrecedence: Precedence }[] = [
  {
    name: 'claude-code',
    markers: ['.claude/', '.claude.json'],
    skills: '.claude/skills',
    mcp: '.claude.json',
    skillPrecedence: { project: ['.claude/skills'], winner: () => ({ winner: 'user', rule: 'Claude Code runs a personal skill over a project skill of the same name' }) },
    mcpPrecedence: { project: ['.mcp.json'], winner: () => ({ winner: 'project', rule: 'Claude Code uses the project-scope server over the user-scope one, once the project server is approved' }) },
  },
  {
    name: 'codex',
    markers: ['.codex/'],
    skills: '.agents/skills',
    mcp: '.codex/config.toml',
    skillPrecedence: { project: ['.agents/skills'], winner: () => ({ winner: 'both', rule: 'Codex does not merge skills of the same name: both appear in its skill selectors' }) },
    mcpPrecedence: { project: ['.codex/config.toml'], winner: () => ({ winner: 'project', rule: 'Codex reads the project .codex/config.toml over the user config in a trusted project; in an untrusted one only the user config' }) },
  },
  {
    name: 'omp',
    markers: ['.omp/'],
    skills: '.agents/skills',
    mcp: '.omp/agent/mcp.json',
    skillPrecedence: {
      project: ['.claude/skills', '.agents/skills'],
      winner: (project) => ({
        winner: 'project',
        rule: project === '.claude/skills' ? 'OMP ranks a project .claude/skills skill (priority 80) over ~/.agents/skills (70) and renames the other <namespace>/<name>' : 'OMP lists project .agents/skills entries before user ones and renames the other <namespace>/<name>',
      }),
    },
    mcpPrecedence: {
      project: ['.omp/mcp.json', '.omp/.mcp.json', '.mcp.json', '.codex/config.toml'],
      winner: (project) =>
        project.startsWith('.omp/')
          ? { winner: 'project', rule: `OMP reads a project ${project} before its user mcp.json` }
          : { winner: 'user', rule: 'OMP reads its native user mcp.json before a project .mcp.json or .codex/config.toml' },
    },
  },
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

/** An installed Taigent skill older than the running taigent (`version`: its `metadata.taigent-version`, null when it has none). */
export interface OutdatedSkill {
  scope: 'user' | 'project';
  /** Its directory: `~/...` for the user, relative to the working directory for the project. */
  path: string;
  version: string | null;
}

/** A Taigent skill or the `taiga` MCP server installed both for the user and in the working directory, as one client sees it. */
export interface Duplicate {
  kind: 'skill' | 'mcp';
  /** The skill name, or `taiga`. */
  name: string;
  client: string;
  /** The user copy (`~/...`: skill directory or MCP config) and the project copy the client reads first. */
  user: string;
  project: string;
  winner: DuplicateWinner;
  rule: string;
}

export interface InstallCheck {
  /** The version of the running taigent, which setup stamps into every skill it installs. */
  taigentVersion: string;
  outdatedSkills: OutdatedSkill[];
  duplicates: Duplicate[];
}

/** A file setup cannot merge into (not JSON/TOML, or not the expected shape), or the wrong directory. Nothing is written. */
export class SetupError extends Error {}

const SKILL_STATUS: Record<SkillFile['status'], SetupStatus> = { missing: 'created', changed: 'updated', extra: 'removed', same: 'unchanged' };

/** The npm version of the running taigent: the `taigent` devDependency `setup --project` pins and the version stamped into the skills. */
async function taigentVersion(): Promise<string> {
  const { version } = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
  return version;
}

/** A skill file as setup installs it: its `SKILL.md` stamped with `version`, every other file as it is. */
function stamped(version: string): SkillContent {
  return (file, source) => (file === 'SKILL.md' ? Buffer.from(stampSkillVersion(source.toString('utf8'), version)) : source);
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
 * a SetupError while planning leaves `root` untouched. The Taigent skill directories are planned whole, each skill as
 * `skillContent` makes it. Reported paths start with `shownRoot` (`~/` for the home directory).
 */
class FilePlan {
  readonly files: SetupFile[] = [];
  private readonly writes: { path: string; content: string | Buffer }[] = [];
  private readonly skillCopies: { dir: string; comparison: SkillDirsComparison }[] = [];

  private readonly root: string;
  private readonly skillContent: SkillContent;
  private readonly shownRoot: string;

  constructor(root: string, skillContent: SkillContent, shownRoot = '') {
    this.root = root;
    this.skillContent = skillContent;
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
    const comparison = await compareSkillDirs(join(PACKAGE_ROOT, SKILLS_SOURCE), join(this.root, dir), this.skillContent);
    this.skillCopies.push({ dir, comparison });
    for (const { skill, file, status } of comparison.files) this.files.push({ path: `${this.shownRoot}${dir}/${skill}/${file}`, status: SKILL_STATUS[status] });
  }

  /** Writes every planned change (unless `dryRun`) and returns the report. */
  async commit(dryRun: boolean): Promise<SetupReport> {
    if (!dryRun) {
      for (const { dir, comparison } of this.skillCopies) await copySkills(join(PACKAGE_ROOT, SKILLS_SOURCE), join(this.root, dir), comparison, this.skillContent);
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
  const version = await taigentVersion();
  const plan = new FilePlan(root, stamped(version));
  for (const dir of [SKILLS_SOURCE, SKILLS_TARGET]) await plan.skills(dir);
  for (const path of HEADLESS_KIT) await plan.file(path, await readFile(join(PACKAGE_ROOT, path)));
  await plan.merge('.mcp.json', (text, file) => mergeMcpJson(file, text, PROJECT_SERVER.json));
  await plan.merge('.codex/config.toml', (text, file) => mergeCodexToml(file, text, PROJECT_SERVER.codex));
  await plan.merge('package.json', (text) => mergePackageJson(text, version));
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

/** Whether one of a client's `markers` is under `home`. */
async function clientFound(home: string, markers: string[]): Promise<boolean> {
  for (const marker of markers) if (await exists(home, marker)) return true;
  return false;
}

/**
 * Installs the Taigent skills and the `taiga` MCP server into the user config, under `home`, of every client found
 * there (`taigent setup`; with `dryRun`, only reports what it would do). A client that is not there is skipped: nothing
 * is created for it. A skills directory two clients share is written once.
 */
export async function setupUser(home: string, { dryRun }: { dryRun: boolean }): Promise<SetupReport> {
  const plan = new FilePlan(home, stamped(await taigentVersion()), '~/');
  const clients: SetupClient[] = [];
  const skillDirs = new Set<string>();
  for (const { name, markers, skills, mcp } of USER_CLIENTS) {
    if (!(await clientFound(home, markers))) {
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

/**
 * Whether `installed` (a skill's `metadata.taigent-version`) is older than `current` by semver precedence (a prerelease
 * precedes its release); a version that is not semver is older unless it is `current` itself.
 */
function isOlder(installed: string, current: string): boolean {
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;
  const [a, b] = [semver.exec(installed), semver.exec(current)];
  if (!a || !b) return installed !== current;
  for (const part of [1, 2, 3]) {
    const difference = Number(a[part]) - Number(b[part]);
    if (difference !== 0) return difference < 0;
  }
  if (a[4] === b[4] || a[4] === undefined) return false;
  return b[4] === undefined || a[4].localeCompare(b[4], 'en', { numeric: true }) < 0;
}

/** The Taigent skills of `root/dir` older than `version`, reported under `shownRoot`. */
async function outdatedSkills(root: string, dir: string, shownRoot: string, scope: OutdatedSkill['scope'], version: string): Promise<OutdatedSkill[]> {
  const outdated: OutdatedSkill[] = [];
  for (const skill of await listSkills(join(root, dir))) {
    const installed = skillVersion((await readExisting(join(root, dir, skill, 'SKILL.md')))?.toString('utf8') ?? '');
    if (installed === undefined || isOlder(installed, version)) outdated.push({ scope, path: `${shownRoot}${dir}/${skill}`, version: installed ?? null });
  }
  return outdated;
}

/** Whether the MCP config at `path` (JSON `mcpServers`, or a Codex TOML `mcp_servers`) defines `taiga`; an unreadable file defines nothing. */
async function definesTaiga(path: string): Promise<boolean> {
  const text = (await readExisting(path))?.toString('utf8');
  if (text === undefined) return false;
  try {
    const toml = path.endsWith('.toml');
    const config: unknown = toml ? parseToml(text) : JSON.parse(text);
    const servers = isRecord(config) ? config[toml ? 'mcp_servers' : 'mcpServers'] : undefined;
    return isRecord(servers) && isRecord(servers.taiga);
  } catch {
    return false;
  }
}

/** `path` with symbolic links resolved, or as given when it does not exist. */
async function realPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

/**
 * What setup reports after its files, for both scopes whichever it installed: the Taigent skills older than the running
 * taigent (in the skills directories of the clients found in `home`, and `.agents/skills`/`.claude/skills` of `cwd`
 * unless it is taigent's own repository, whose sources carry no version), and the Taigent skills and `taiga` server
 * installed both in `home` and in `cwd` for a client found in `home`, with the copy that client uses. Nothing when `cwd`
 * is `home`. Reads only; never removes anything.
 */
export async function checkInstall(home: string, cwd: string): Promise<InstallCheck> {
  const version = await taigentVersion();
  const clients: (typeof USER_CLIENTS)[number][] = [];
  for (const client of USER_CLIENTS) if (await clientFound(home, client.markers)) clients.push(client);
  const project = await realPath(cwd);
  const projectIsHome = project === (await realPath(home));

  const outdated: OutdatedSkill[] = [];
  for (const dir of new Set(clients.map(({ skills }) => skills))) outdated.push(...(await outdatedSkills(home, dir, '~/', 'user', version)));
  if (!projectIsHome && project !== (await realPath(PACKAGE_ROOT))) {
    for (const dir of [SKILLS_SOURCE, SKILLS_TARGET]) outdated.push(...(await outdatedSkills(cwd, dir, '', 'project', version)));
  }

  const duplicates: Duplicate[] = [];
  if (projectIsHome) return { taigentVersion: version, outdatedSkills: outdated, duplicates };
  for (const { name: client, skills, mcp, skillPrecedence, mcpPrecedence } of clients) {
    const projectSkills = await Promise.all(skillPrecedence.project.map(async (dir) => ({ dir, skills: await listSkills(join(cwd, dir)) })));
    for (const skill of await listSkills(join(home, skills))) {
      const dir = projectSkills.find(({ skills: names }) => names.includes(skill))?.dir;
      if (dir) duplicates.push({ kind: 'skill', name: skill, client, user: `~/${skills}/${skill}`, project: `${dir}/${skill}`, ...skillPrecedence.winner(dir) });
    }
    if (!(await definesTaiga(join(home, mcp)))) continue;
    for (const file of mcpPrecedence.project) {
      if (!(await definesTaiga(join(cwd, file)))) continue;
      duplicates.push({ kind: 'mcp', name: 'taiga', client, user: `~/${mcp}`, project: file, ...mcpPrecedence.winner(file) });
      break;
    }
  }
  return { taigentVersion: version, outdatedSkills: outdated, duplicates };
}

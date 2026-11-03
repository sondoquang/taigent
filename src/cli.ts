// CLI: argument parsing, wiring of Manifest → Taiga client → Planner → Executor, output and exit codes.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { AdoptError, adoptItem } from './adopt.ts';
import { describeBootstrapOperation, executeBootstrap, planBootstrap, readBootstrapRemote } from './bootstrap.ts';
import { ExitCode } from './exit-codes.ts';
import { describeAppliedOperation, executePlan } from './executor.ts';
import { errorMessage } from './guards.ts';
import { legacyStoryCreatesError, unknownIssueValuesError } from './manifest/backlog.ts';
import { KEY_PATTERN, PROJECT_SLUG_PATTERN } from './manifest/conventions.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { manifestsRoot, projectLayout } from './manifest/layout.ts';
import { listProjectSlugs, loadManifests, type LoadedProject } from './manifest/manifests.ts';
import { initRepository, InitError, type InitStatus } from './init.ts';
import { LOGIN_HINT, LoginError, normalizeApiUrl, removeLogin, StoredSession, storeLogin } from './login.ts';
import { serveMcp, startProxy } from './mcp.ts';
import type { Action, PlanSummary, Result } from './operations.ts';
import { buildPlan, describePlanOperation, LegacyStoryCreateError, RefMismatchError, UnknownIssueValueError, type Plan } from './planner.ts';
import { NOTIFY_KINDS, NotifyConfigError, type NotifyKind, notifyMessage, notifyRange, resolveTelegram, sendTelegram, TelegramError } from './notify.ts';
import { ask, askHidden, isTerminal, PromptCancelled } from './prompt.ts';
import { formatProjectDetailText, formatProjectsText, readProjectDetail, readProjects } from './projects.ts';
import { formatProjectReportText, readProjectReport } from './report.ts';
import { readBacklogRemote } from './remote.ts';
import { buildPreview, loadReview, renderPreviewMarkdown, REVIEW_FILE, reviewKeys } from './review.ts';
import { Secrets } from './secrets.ts';
import { compareSkills, SKILLS_SOURCE, SKILLS_TARGET, SkillsSourceMissingError, syncSkills } from './skills.ts';
import { TaigaAuthError, type TaigaAuthorizer, TaigaClient, TaigaConflictError, TaigaError } from './taiga/client.ts';
import { commentTicket, parseRef, setTicketStatus, TicketError } from './ticket.ts';
import { dayRange, formatTicketsText, parseDay, readTickets } from './tickets.ts';
import { describeUploadOperation, executeUpload, planUpload, readUploadRemote, UploadTooLargeError } from './upload.ts';

const USAGE = `Usage: taigent <command> [--project <slug>] [options]

Commands:
  init      Install Taigent into the repository at the working directory, from this taigent: the Taigent skills,
            the taiga MCP server entries, the headless kit and the pinned taigent devDependency; offline
  validate  Check manifests (and review.yaml) against the conventions, offline (all projects without --project)
  preview   Show the backlog as apply would write it, with its review (review.yaml), as one Markdown page; offline
  bootstrap Create or complete the Taiga project declared in project.yaml (requires --yes)
  plan      Show what apply would change on Taiga (exit 3 when there are changes)
  apply     Apply the manifest to Taiga (requires --yes)
  adopt     Write the hand-made epic or issue #--ref of --project into backlog.yaml as backlog item --key, verbatim
            (plan then proposes adopting it: apply adds its src:<key> tag); reads Taiga, writes the manifest only
  upload    Upsert the wiki pages and attachments declared in docs.yaml (requires --yes)
  tickets   List your tickets (user stories) closed or due from --from to --to, and every open one, with due status (read-only)
  projects  List the Taiga projects you are a member of, with admin rights and whether taiga/<slug>/ exists; with
            --project, that project's issue types, severities and priorities (read-only)
  report    Progress of --project by sprint (stories, tasks and points done, blocked stories) and by epic, and its
            stories in no sprint (read-only)
  status <ref> <status>   Move your ticket #<ref> of --project to that status, e.g. \`status 84 Done\` (writes at once)
  comment <ref> <text>    Add a comment to your ticket #<ref> of --project (writes at once)
  notify week|day|eod     Send your tickets of the week, of the day, or those still open and due by today to your
            Telegram chat (--dry-run prints the message instead)
  skills sync   Copy the Taigent skills (taiga-*, ask-taigent, prd-to-taiga) from ${SKILLS_SOURCE} to ${SKILLS_TARGET} (run from the repository root)
  skills check  Compare them (exit 3 when the copies differ)
  login     Log in once, in your own terminal: the password is exchanged for a token kept in the OS credential
            store (Windows Credential Manager, macOS Keychain, Linux Secret Service), never stored itself
  logout    Delete the stored login (an application token is deleted on Taiga too)
  whoami    Show the Taiga user the credentials act as (TAIGA_* or the stored login), checked against Taiga
  mcp       Run the Taiga MCP server on stdin/stdout for an agent (.mcp.json, .codex/config.toml)

Options:
  --project <slug>  Taiga project slug; manifests are read from <manifests>/<slug>/ (optional for tickets, notify and projects)
  --from, --to      tickets: first and last day (YYYY-MM-DD, inclusive, local time zone)
  --ref <n>, --key <KEY>  adopt: the Taiga ref of the hand-made item and the key of the new backlog item
  --out <file>      preview: write the page (or the JSON) to this file instead of stdout
  --application <id>  login: store an application token of this Application (created by the instance admin)
                    instead of a refresh token
  --json            Machine-readable output on stdout
  --yes             Confirm writes (bootstrap, apply, upload)
  --dry-run         List the operations without writing anything (exit 3 when there are changes; init: the files it
                    would write); notify: print the message without sending it (exit 0)
  -h, --help        Show this help

Credentials: TAIGA_USERNAME + TAIGA_PASSWORD or TAIGA_TOKEN when set, else the stored login (taigent login).
Environment (a variable not set in the environment is read from ./.env):
  TAIGA_API_URL                    Taiga API base URL (includes /api/v1); with a stored login, must match it if set
  TAIGA_USERNAME, TAIGA_PASSWORD   Login; also the fallback when TAIGA_TOKEN is rejected
  TAIGA_TOKEN                      Access token used instead of username/password
  TAIGENT_MANIFESTS_DIR            Manifests root (default: ./taiga)
  TAIGENT_RETRY_UNIT_MS            Milliseconds per second of 429 backoff (default: 1000)
  TAIGENT_CREDENTIAL_STORE         Where login keeps its token: keyring (default) or file (plain JSON in the config
                                   directory, for machines without an OS credential store)
  TAIGENT_CONFIG_DIR               Config directory of the stored login (default: per-user, e.g. %APPDATA%\\taigent)
  TAIGENT_READ_ONLY                1: refuse every write to Taiga (apply/upload/bootstrap --yes, status, comment) with
                                   exit 2; plan, preview, validate and --dry-run still work (Taigent Desktop's headless runs)
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  notify: the bot and your chat; default: the Claude Code Telegram plugin's
                                   .env and its single paired user (access.json) in TELEGRAM_STATE_DIR
                                   (default: <CLAUDE_CONFIG_DIR or ~/.claude>/channels/telegram)

Exit codes: 0 ok/no changes, 1 internal error, 2 usage/config error (incl. changes without --yes, not logged in,
            a write under TAIGENT_READ_ONLY), 3 plan/--dry-run/skills check has changes, 4 manifest invalid,
            5 Taiga/network error`;

const COMMANDS = ['init', 'validate', 'preview', 'bootstrap', 'plan', 'apply', 'adopt', 'upload', 'tickets', 'projects', 'report', 'status', 'comment', 'notify', 'skills', 'login', 'logout', 'whoami', 'mcp'] as const;
/** Commands that work without --project. */
const PROJECTLESS: readonly Command[] = ['init', 'validate', 'skills', 'tickets', 'projects', 'notify', 'login', 'logout', 'whoami', 'mcp'];

const SKILLS_ACTIONS = ['sync', 'check'] as const;
type SkillsAction = (typeof SKILLS_ACTIONS)[number];
type Command = (typeof COMMANDS)[number];

/** Bad usage or configuration. Maps to ExitCode.Usage. */
class UsageError extends Error {}

/** A Taiga write refused under TAIGENT_READ_ONLY. Maps to ExitCode.Usage, kind `read-only`. */
class ReadOnlyError extends Error {}

/** Commands that write to Taiga with `--yes` (without `--dry-run`), and those that write at once. */
const CONFIRMED_WRITES: readonly Command[] = ['apply', 'upload', 'bootstrap'];
const IMMEDIATE_WRITES: readonly Command[] = ['status', 'comment'];

/**
 * TAIGENT_READ_ONLY=1 (Taigent Desktop sets it on its headless skill runs, and the agent's shell inherits it): a
 * command that would write to Taiga is refused before it contacts Taiga, whatever the agent was told.
 */
function refuseReadOnlyWrite({ options, env }: Run): void {
  if (env.TAIGENT_READ_ONLY !== '1') return;
  const writes = IMMEDIATE_WRITES.includes(options.command) || (CONFIRMED_WRITES.includes(options.command) && options.yes && !options.dryRun);
  if (!writes) return;
  throw new ReadOnlyError(
    `${options.command} writes to Taiga, refused because TAIGENT_READ_ONLY is set (a headless run of Taigent Desktop); ` +
      'plan, preview, validate and --dry-run still work. Push from the app, or run it in a terminal without TAIGENT_READ_ONLY',
  );
}

interface Options {
  command: Command;
  /** Required by every command except those in PROJECTLESS. */
  project?: string;
  /** Range commands (`tickets`): first and last day, YYYY-MM-DD. */
  from?: string;
  to?: string;
  /** `skills` subcommand. */
  skillsAction?: SkillsAction;
  /** `status`, `comment`: the ticket's ref; `adopt`: the hand-made item's ref (`--ref`). */
  ref?: number;
  /** `status`: the status name (its words joined by spaces); `comment`: the comment text. */
  text?: string;
  /** `adopt`: key of the new backlog item (`--key`). */
  key?: string;
  /** `notify`: which message. */
  notifyKind?: NotifyKind;
  /** `login`: Application id for an application token. */
  application?: string;
  /** `preview`: file to write instead of stdout. */
  out?: string;
  json: boolean;
  yes: boolean;
  dryRun: boolean;
}

/** One CLI run: its options, environment, working directory, and the secrets none of its output may show. */
interface Run {
  options: Options;
  env: NodeJS.ProcessEnv;
  cwd: string;
  secrets: Secrets;
}

/** Every write to stdout goes through here (and every write to stderr through `printError`), redacted. */
function print(run: Run, text: string): void {
  process.stdout.write(run.secrets.redact(text));
}

function printError(secrets: Secrets, text: string): void {
  process.stderr.write(secrets.redact(text));
}

function parseOptions(argv: string[]): Options | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        application: { type: 'string' },
        out: { type: 'string' },
        ref: { type: 'string' },
        key: { type: 'string' },
        json: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  const [command, ...extra] = positionals;
  if (!command) throw new UsageError('missing command');
  if (!COMMANDS.includes(command as Command)) throw new UsageError(`unknown command "${command}"`);
  let skillsAction: SkillsAction | undefined;
  if (command === 'skills') {
    const action = extra.shift();
    if (!SKILLS_ACTIONS.includes(action as SkillsAction)) throw new UsageError(`skills needs one of: ${SKILLS_ACTIONS.join(', ')}`);
    skillsAction = action as SkillsAction;
  }
  let ref: number | undefined;
  let text: string | undefined;
  if (command === 'status' || command === 'comment') {
    // The rest of the words, so `status 84 In progress` needs no quotes (PowerShell 5.1 mangles them).
    const [refArg, ...words] = extra.splice(0);
    const what = command === 'status' ? '<status>' : '<text>';
    ref = refArg === undefined ? undefined : parseRef(refArg);
    if (ref === undefined) throw new UsageError(`${command} needs the ticket's ref (e.g. 84 or #84), then ${what}${refArg === undefined ? '' : `, got "${refArg}"`}`);
    text = words.join(' ').trim();
    if (text === '') throw new UsageError(`${command} needs ${what} after the ref`);
  }
  let key: string | undefined;
  if (command === 'adopt') {
    ref = values.ref === undefined ? undefined : parseRef(values.ref);
    if (ref === undefined) throw new UsageError(`adopt needs --ref <n>, the Taiga ref of the hand-made item (e.g. 84 or #84)${values.ref === undefined ? '' : `, got "${values.ref}"`}`);
    key = values.key;
    if (key === undefined || !KEY_PATTERN.test(key)) {
      throw new UsageError(`adopt needs --key <KEY> for the new backlog item, matching ${KEY_PATTERN} (e.g. AUTH-LOGIN)${key === undefined ? '' : `, got "${key}"`}`);
    }
  } else if (values.ref !== undefined || values.key !== undefined) {
    throw new UsageError('--ref and --key apply only to adopt');
  }
  let notifyKind: NotifyKind | undefined;
  if (command === 'notify') {
    const kind = extra.shift();
    if (!NOTIFY_KINDS.includes(kind as NotifyKind)) throw new UsageError(`notify needs one of: ${NOTIFY_KINDS.join(', ')}`);
    notifyKind = kind as NotifyKind;
  }
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  if (values.project === undefined) {
    if (!PROJECTLESS.includes(command as Command)) throw new UsageError('--project <slug> is required');
  } else if (!PROJECT_SLUG_PATTERN.test(values.project)) {
    throw new UsageError(`invalid project slug "${values.project}"`);
  }
  if (values.application !== undefined && command !== 'login') throw new UsageError('--application applies only to login');
  if (values.application === '') throw new UsageError('--application needs the Application id');
  if (values.out !== undefined && command !== 'preview') throw new UsageError('--out applies only to preview');
  if (values.out === '') throw new UsageError('--out needs a file path');
  if (command === 'tickets') {
    for (const name of ['from', 'to'] as const) {
      const value = values[name];
      if (value === undefined) throw new UsageError(`${command} needs --${name} <YYYY-MM-DD>`);
      if (!parseDay(value)) throw new UsageError(`--${name} must be a calendar day as YYYY-MM-DD, got "${value}"`);
    }
    if (parseDay(values.from!)! > parseDay(values.to!)!) throw new UsageError(`--from ${values.from} is after --to ${values.to}`);
  } else if (values.from !== undefined || values.to !== undefined) {
    throw new UsageError('--from and --to apply only to tickets');
  }
  return {
    command: command as Command,
    project: values.project,
    from: values.from,
    to: values.to,
    skillsAction,
    ref,
    text,
    key,
    notifyKind,
    application: values.application,
    out: values.out,
    json: values.json,
    yes: values.yes,
    dryRun: values['dry-run'],
  };
}

function requireEnv(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new UsageError(`missing environment variable(s): ${missing.join(', ')}`);
  return names.map((name) => env[name]!);
}

/** `env` completed from `<cwd>/.env`, if there is one: a variable set (non-empty) in `env` wins over the file. */
function withDotEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  let text: string;
  try {
    text = readFileSync(join(cwd, '.env'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return env;
    throw new UsageError(`cannot read .env: ${errorMessage(error)}`);
  }
  const merged = { ...env };
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (!merged[name]) merged[name] = value;
  }
  return merged;
}

/**
 * The secrets of the environment: TAIGA_PASSWORD, TAIGA_TOKEN and the password of a `user:password@` in TAIGA_API_URL
 * (raw and decoded). The client adds the tokens it obtains.
 */
function environmentSecrets(env: NodeJS.ProcessEnv): Secrets {
  const secrets = new Secrets();
  secrets.add(env.TAIGA_PASSWORD);
  secrets.add(env.TAIGA_TOKEN);
  const url = env.TAIGA_API_URL && URL.canParse(env.TAIGA_API_URL) ? new URL(env.TAIGA_API_URL) : undefined;
  if (url?.password) {
    secrets.add(url.password);
    secrets.add(decodeURIComponent(url.password));
  }
  return secrets;
}

/** Where a run's Taiga credentials come from. */
type Auth =
  | { source: 'environment'; apiUrl: string; token?: string; credentials?: { username: string; password: string } }
  | { source: 'login'; apiUrl: string; session: StoredSession };

/**
 * TAIGA_TOKEN or TAIGA_USERNAME/TAIGA_PASSWORD when set (environment or .env; with both, the password is the
 * fallback when Taiga rejects the token), else the stored login of `taigent login`.
 */
async function resolveAuth({ env, secrets }: Run): Promise<Auth> {
  const token = env.TAIGA_TOKEN || undefined;
  const credentials = env.TAIGA_USERNAME && env.TAIGA_PASSWORD ? { username: env.TAIGA_USERNAME, password: env.TAIGA_PASSWORD } : undefined;
  if (token || credentials) {
    const [apiUrl] = requireEnv(env, ['TAIGA_API_URL']);
    const url = URL.canParse(apiUrl!) ? new URL(apiUrl!) : undefined;
    if (url?.username || url?.password) {
      throw new UsageError('TAIGA_API_URL must not contain credentials (user:password@); set TAIGA_USERNAME and TAIGA_PASSWORD (or TAIGA_TOKEN) instead');
    }
    return { source: 'environment', apiUrl: apiUrl!, token, credentials };
  }
  const session = await StoredSession.open(env, secrets);
  if (!session) throw new LoginError(`not logged in to Taiga: ${LOGIN_HINT}, or set TAIGA_USERNAME and TAIGA_PASSWORD (or TAIGA_TOKEN)`);
  const wanted = env.TAIGA_API_URL;
  if (wanted && normalizeApiUrl(wanted) !== session.record.apiUrl) {
    throw new LoginError(`TAIGA_API_URL is ${wanted}, but the stored login is for ${session.record.apiUrl}: ${LOGIN_HINT} to log in to ${wanted}, or unset TAIGA_API_URL`);
  }
  return { source: 'login', apiUrl: session.record.apiUrl, session };
}

async function connectTaiga(run: Run, auth?: Auth): Promise<TaigaClient> {
  const resolved = auth ?? (await resolveAuth(run));
  const common = { apiUrl: resolved.apiUrl, retryUnitMs: retryUnitMs(run.env), secrets: run.secrets };
  if (resolved.source === 'login') return TaigaClient.connect({ ...common, authorizer: resolved.session });
  return TaigaClient.connect({ ...common, token: resolved.token, credentials: resolved.credentials });
}

/** TAIGENT_RETRY_UNIT_MS: milliseconds per second of 429 backoff (default 1000). */
function retryUnitMs(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env.TAIGENT_RETRY_UNIT_MS;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`TAIGENT_RETRY_UNIT_MS must be a non-negative integer (milliseconds), got "${raw}"`);
  }
  return value;
}

const MARKER: Record<Action, string> = { create: '  + ', update: '  ~ ', adopt: '  ~ ', link: '  + ', skip: '    skip ' };

/** Text form of a plan: a title, one line per operation, `extra` lines (e.g. orphans), then the counts. */
function formatPlanText<A extends Action, O extends { action: A }>(
  title: string,
  plan: PlanSummary<A> & { operations: O[] },
  describe: (op: O) => string,
  texts: { empty: string; matches: string; extra?: string[] },
): string {
  const lines = [title, ...plan.operations.map((op) => `${MARKER[op.action]}${describe(op)}`)];
  if (plan.operations.length === 0) lines.push(`  (${texts.empty})`);
  lines.push(...(texts.extra ?? []));
  const counts = Object.entries<number>(plan.summary).map(([action, n]) => `${n} ${action === 'skip' ? 'unchanged' : `to ${action}`}`);
  lines.push(plan.changes ? `${counts.join(', ')}.` : `No changes. Taiga matches ${texts.matches}.`);
  return `${lines.join('\n')}\n`;
}

/** Text form of a report: a title, one line per operation that wrote something, then the counts. */
function formatReportText<O extends { result: Result }>(
  title: string,
  report: { operations: O[]; summary: Partial<Record<Result, number>> },
  describe: (op: O) => string,
): string {
  const lines = [title, ...report.operations.filter((op) => op.result !== 'unchanged').map((op) => `  ${op.result} ${describe(op)}`)];
  lines.push(`${Object.entries(report.summary).map(([result, n]) => `${n} ${result}`).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

/** The parts of a backlog plan that are reported but never acted on: orphans, stale epic links, hand-made children. */
function formatLeftovers(plan: Plan): string[] {
  const lines: string[] = [];
  if (plan.orphans.length > 0) {
    lines.push('Orphans (tagged src: on Taiga but not in the manifest; never deleted):');
    lines.push(...plan.orphans.map((orphan) => `  ! orphan ${orphan.type} ${orphan.key}  (#${orphan.ref}, id ${orphan.id})  "${orphan.subject}"`));
  }
  if (plan.staleLinks.length > 0) {
    lines.push('Stale links (story linked on Taiga to an epic it no longer belongs to in the manifest):');
    lines.push(
      ...plan.staleLinks.map(
        (link) =>
          `  ! stale link story ${link.key}  (#${link.ref}, id ${link.id}) -> epic ${link.epic}  (#${link.epicRef}, id ${link.epicId}): never removed; unlink it on Taiga if obsolete`,
      ),
    );
  }
  if (plan.handMadeChildren.length > 0) {
    lines.push('Hand-made children (on Taiga under a backlog item, not in the manifest; left untouched):');
    lines.push(
      ...plan.handMadeChildren.map(
        (child) => `  - hand-made ${child.type} #${child.ref} (id ${child.id})  "${child.subject}"  in ${child.type === 'task' ? 'story' : 'epic'} ${child.parent}`,
      ),
    );
  }
  return lines;
}

/** Prints `value` as JSON with --json, else `text()`. */
function emit(run: Run, value: unknown, text: () => string): void {
  print(run, run.options.json ? `${JSON.stringify(value, null, 2)}\n` : text());
}

/**
 * The review gate of plan/apply, bootstrap and upload. Unless the run may write (`--yes` without `--dry-run`; never
 * for `plan`), it prints the plan and returns the exit code: 0 without changes, 3 for `plan` and `--dry-run`, and a
 * usage error (2) for a writing command without `--yes`. Returns undefined when the run goes on to write.
 */
function reviewGate(run: Run, plan: { changes: boolean }, text: () => string): number | undefined {
  const { options } = run;
  const review = options.command === 'plan' || options.dryRun;
  if (options.yes && !review) return undefined;
  emit(run, plan, text);
  if (!plan.changes) return ExitCode.Ok;
  if (review) return ExitCode.Changes;
  throw new UsageError(`refusing to ${options.command} without --yes; review the operations above, then re-run with --yes`);
}

/**
 * Validates one project's manifests, or every project under the manifests root, and their review.yaml (whose keys are
 * checked against a valid backlog). Offline: no env needed.
 */
async function runValidate(run: Run): Promise<number> {
  const { options, env, cwd } = run;
  const root = manifestsRoot(env, cwd);
  const slugs = options.project ? [options.project] : await listProjectSlugs(root);
  if (slugs.length === 0) {
    throw new ManifestError([{ file: root, path: '', rule: 'file-exists', message: 'no project manifest directory found' }]);
  }
  const projects: LoadedProject[] = [];
  const issues: ManifestIssue[] = [];
  for (const slug of slugs) {
    const { dir } = projectLayout(slug, env, cwd);
    let project: LoadedProject | undefined;
    try {
      project = await loadManifests(dir, slug);
      projects.push(project);
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      issues.push(...error.issues);
    }
    const reviewPath = join(dir, REVIEW_FILE);
    if (!existsSync(reviewPath)) continue;
    // Review keys are only checked against a valid backlog; an invalid one already reports its issues.
    const backlog = project?.manifests.backlog;
    try {
      await loadReview(reviewPath, backlog ? reviewKeys(backlog) : undefined);
      project?.files.push(reviewPath);
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length > 0) throw new ManifestError(issues);

  const report = projects.map(({ slug, files }) => ({ slug, files: files.map((file) => relative(cwd, file)) }));
  print(
    run,
    options.json
      ? `${JSON.stringify({ valid: true, projects: report }, null, 2)}\n`
      : `${report.flatMap(({ files }) => files.map((file) => `${file}: ok`)).join('\n')}\nAll manifests follow the conventions.\n`,
  );
  return ExitCode.Ok;
}

/** `preview`: the backlog as apply would write it, with its review, as Markdown (or JSON). Offline: no env needed. */
async function runPreview(run: Run): Promise<number> {
  const { options, env, cwd } = run;
  const slug = options.project!;
  const preview = await buildPreview(projectLayout(slug, env, cwd).dir, slug);
  const output = options.json ? `${JSON.stringify(preview, null, 2)}\n` : renderPreviewMarkdown(preview);
  if (options.out === undefined) {
    print(run, output);
    return ExitCode.Ok;
  }
  const path = resolve(cwd, options.out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, output);
  emit(run, { out: relative(cwd, path) }, () => `Preview written to ${relative(cwd, path)}\n`);
  return ExitCode.Ok;
}

/** `bootstrap`: create the project declared in project.yaml, or fill what an existing one lacks. */
async function runBootstrap(run: Run): Promise<number> {
  const slug = run.options.project!;
  const layout = projectLayout(slug, run.env, run.cwd);
  const manifest = (await loadManifests(layout.dir, slug, { require: ['project'] })).manifests.project!;
  const client = await connectTaiga(run);

  const remote = await readBootstrapRemote(manifest, client, layout.state);
  const plan = planBootstrap(manifest, remote);

  const gate = reviewGate(run, plan, () =>
    formatPlanText(`Bootstrap plan for project ${plan.project.slug} (${plan.project.exists ? `id ${plan.project.id}` : 'new'}):`, plan, describeBootstrapOperation, {
      empty: 'project.yaml declares nothing',
      matches: 'the manifest',
    }),
  );
  if (gate !== undefined) return gate;

  const report = await executeBootstrap(plan, remote.project, client, layout.state);
  emit(run, report, () => formatReportText(`Bootstrapped project ${report.project.slug} (id ${report.project.id}):`, report, describeBootstrapOperation));
  return ExitCode.Ok;
}

/** `upload`: upsert docs.yaml's wiki pages by slug and add its attachments that Taiga lacks. */
async function runUpload(run: Run): Promise<number> {
  const slug = run.options.project!;
  const { manifests } = await loadManifests(projectLayout(slug, run.env, run.cwd).dir, slug, { require: ['docs'] });
  const client = await connectTaiga(run);
  const remote = await readUploadRemote(manifests.docs!, manifests.backlog, client, slug);
  const plan = planUpload(manifests.docs!, remote, run.cwd);

  const gate = reviewGate(run, plan, () =>
    formatPlanText(`Upload plan for project ${plan.project.slug} (id ${plan.project.id}):`, plan, describeUploadOperation, {
      empty: 'docs.yaml declares nothing',
      matches: 'docs.yaml',
    }),
  );
  if (gate !== undefined) return gate;

  const report = await executeUpload(plan, client, run.cwd);
  emit(run, report, () =>
    formatReportText(`Uploaded to project ${report.project.slug} (id ${report.project.id}):`, report, (op) => `${describeUploadOperation(op)}  -> id ${op.id}`),
  );
  return ExitCode.Ok;
}

/**
 * `init`: install Taigent into the repository at the working directory, from the running taigent. Offline; exit 3 for
 * a dry run with changes.
 */
async function runInit(run: Run): Promise<number> {
  const { options, cwd } = run;
  const report = await initRepository(cwd, { dryRun: options.dryRun });
  const count = (status: InitStatus) => report.files.filter((file) => file.status === status).length;
  const changes = report.files.some(({ status }) => status !== 'unchanged');
  emit(run, report, () => {
    const lines = report.files.filter(({ status }) => status !== 'unchanged').map(({ path, status }) => `${path}: ${status}`);
    const counts = `${count('created')} created, ${count('updated')} updated, ${count('removed')} removed, ${count('unchanged')} unchanged`;
    if (options.dryRun) lines.push(changes ? `Dry run, nothing written. Files that would change: ${counts}.` : `Taigent is up to date (${counts}).`);
    else lines.push(`Taigent installed: ${counts}.`, 'Next: npm install, then npx taigent login in your own terminal.');
    return `${lines.join('\n')}\n`;
  });
  return options.dryRun && changes ? ExitCode.Changes : ExitCode.Ok;
}

/** `skills sync|check`: keep the Claude copies of the Taigent skills identical to their source. Offline. */
async function runSkills(run: Run): Promise<number> {
  const { options, cwd } = run;
  try {
    if (options.skillsAction === 'sync') {
      const report = await syncSkills(cwd);
      const lines = [
        ...report.synced.map((skill) => `${SKILLS_TARGET}/${skill}: synced`),
        ...report.removed.map((skill) => `${SKILLS_TARGET}/${skill}: removed`),
      ];
      print(
        run,
        options.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : `${[...lines, `${report.skills.length} Taigent skill(s) in sync.`].join('\n')}\n`,
      );
      return ExitCode.Ok;
    }
    const comparison = await compareSkills(cwd);
    if (options.json) {
      print(run, `${JSON.stringify(comparison, null, 2)}\n`);
    } else if (comparison.inSync) {
      print(run, `${comparison.skills.length} Taigent skill(s) in sync.\n`);
    } else {
      const lines = comparison.differences.map(({ skill, file, status }) => `${SKILLS_TARGET}/${skill}/${file}: ${status}`);
      print(run, `${lines.join('\n')}\nThe Claude copies differ from ${SKILLS_SOURCE}; run \`taigent skills sync\`.\n`);
    }
    return comparison.inSync ? ExitCode.Ok : ExitCode.Changes;
  } catch (error) {
    if (error instanceof SkillsSourceMissingError) throw new UsageError(error.message);
    throw error;
  }
}

/** `plan` and `apply`: compare backlog.yaml with Taiga, then (apply --yes) run the plan. */
async function runPlan(run: Run): Promise<number> {
  const slug = run.options.project!;
  const layout = projectLayout(slug, run.env, run.cwd);
  const backlog = (await loadManifests(layout.dir, slug, { require: ['backlog'] })).manifests.backlog!;
  const client = await connectTaiga(run);
  const remote = await readBacklogRemote(backlog, client, slug);
  let plan: Plan;
  try {
    plan = buildPlan(backlog, remote);
  } catch (error) {
    if (error instanceof RefMismatchError) {
      throw new ManifestError(error.mismatches.map(({ path, message }) => ({ file: layout.backlog, path, rule: 'item-ref', message })));
    }
    if (error instanceof LegacyStoryCreateError) throw legacyStoryCreatesError(layout.backlog, error.stories);
    if (error instanceof UnknownIssueValueError) throw unknownIssueValuesError(layout.backlog, error.values);
    throw error;
  }

  const gate = reviewGate(run, plan, () =>
    formatPlanText(`Plan for project ${plan.project.slug} (id ${plan.project.id}):`, plan, describePlanOperation, {
      empty: 'manifest has no items',
      matches: 'the manifest',
      extra: formatLeftovers(plan),
    }),
  );
  if (gate !== undefined) return gate;

  const report = await executePlan(plan, client, layout.state, remote.customAttributes);
  emit(run, report, () => formatReportText(`Applied to project ${report.project.slug} (id ${report.project.id}):`, report, describeAppliedOperation));
  return ExitCode.Ok;
}

/**
 * `adopt`: writes the hand-made item `--ref` of the project into backlog.yaml as backlog item `--key`. Reads Taiga,
 * writes the manifest only; plan then proposes the `adopt` action. The project directory is validated first.
 */
async function runAdopt(run: Run): Promise<number> {
  const { options } = run;
  const slug = options.project!;
  const layout = projectLayout(slug, run.env, run.cwd);
  try {
    await loadManifests(layout.dir, slug);
  } catch (error) {
    // A project directory without any manifest yet is fine: adopt writes the first backlog.yaml.
    if (!(error instanceof ManifestError) || !error.issues.every((issue) => issue.rule === 'file-exists')) throw error;
  }
  const adopted = await adoptItem(layout.dir, slug, await connectTaiga(run), { ref: options.ref!, key: options.key! });
  emit(
    run,
    adopted,
    () =>
      `Adopted ${adopted.type} #${adopted.ref} (id ${adopted.id}) as ${adopted.key} at ${adopted.path} of ${relative(run.cwd, layout.backlog)}.\n` +
      `Run taigent plan --project ${slug}: it proposes adopting it, and apply adds its src:${adopted.key.toLowerCase()} tag.\n`,
  );
  return ExitCode.Ok;
}

/** `tickets`: the user's Period's tickets with their due status. Read-only. */
async function runTickets(run: Run): Promise<number> {
  const { options } = run;
  const client = await connectTaiga(run);
  const project = options.project === undefined ? undefined : await client.getProjectBySlug(options.project);
  const report = await readTickets(client, dayRange(options.from!, options.to!), project);
  emit(run, report, () => formatTicketsText(report));
  return ExitCode.Ok;
}

/** `projects`: the user's Taiga projects and their manifest directories, or one project's issue values. Read-only. */
async function runProjects(run: Run): Promise<number> {
  const { options, env, cwd } = run;
  const client = await connectTaiga(run);
  const root = manifestsRoot(env, cwd);
  if (options.project === undefined) {
    const report = await readProjects(client, root);
    emit(run, report, () => formatProjectsText(report, root, cwd));
  } else {
    const report = await readProjectDetail(client, options.project, root);
    emit(run, report, () => formatProjectDetailText(report, root, cwd));
  }
  return ExitCode.Ok;
}

/** `report`: the project's progress by sprint and by epic, and its stories in no sprint. Read-only. */
async function runReport(run: Run): Promise<number> {
  const report = await readProjectReport(await connectTaiga(run), run.options.project!);
  emit(run, report, () => formatProjectReportText(report));
  return ExitCode.Ok;
}

/** `status`: move one of the user's tickets to a status, at once (the request is the confirmation). */
async function runStatus(run: Run): Promise<number> {
  const { options } = run;
  const change = await setTicketStatus(await connectTaiga(run), options.project!, options.ref!, options.text!);
  const { ticket } = change;
  const named = `#${ticket.ref} ${ticket.subject} (${ticket.project.slug})`;
  emit(run, change, () => (change.changed ? `${named}: ${change.from} → ${change.to}\n` : `${named} is already ${change.to}: nothing changed\n`));
  return ExitCode.Ok;
}

/** `comment`: add a comment to one of the user's tickets, at once. */
async function runComment(run: Run): Promise<number> {
  const { options } = run;
  const added = await commentTicket(await connectTaiga(run), options.project!, options.ref!, options.text!);
  emit(run, added, () => `Commented on #${added.ticket.ref} ${added.ticket.subject} (${added.ticket.project.slug})\n`);
  return ExitCode.Ok;
}

/** `notify`: build the week/day/eod message from the user's tickets and send it to their Telegram chat. */
async function runNotify(run: Run): Promise<number> {
  const { options } = run;
  const kind = options.notifyKind!;
  // Before Taiga, so a missing Telegram setup fails fast; the token joins the secrets no output may show.
  const target = options.dryRun ? undefined : resolveTelegram(run.env);
  run.secrets.add(target?.token);
  const client = await connectTaiga(run);
  const project = options.project === undefined ? undefined : await client.getProjectBySlug(options.project);
  const range = notifyRange(kind, new Date());
  const report = await readTickets(client, dayRange(range.from, range.to), project);
  const text = notifyMessage(kind, report);
  if (target && text !== null) await sendTelegram(target, text);
  const sent = target !== undefined && text !== null;
  emit(run, { kind, range, text, sent, chatId: target?.chatId ?? null }, () => {
    if (text === null) return `Nothing to send: no open ticket is due by ${report.today}\n`;
    return sent ? `Sent the ${kind} message to Telegram chat ${target!.chatId}\n` : `${text}\n`;
  });
  return ExitCode.Ok;
}

/** The URL typed at `taigent login`: http(s), no credentials; a bare host gets Taiga's `/api/v1`. */
function loginApiUrl(raw: string): string {
  if (!URL.canParse(raw)) throw new UsageError(`"${raw}" is not a URL (e.g. https://taiga.example.com/api/v1)`);
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UsageError(`the Taiga API URL must start with https:// or http://, got "${raw}"`);
  if (url.username || url.password) throw new UsageError('the Taiga API URL must not contain credentials (user:password@)');
  return normalizeApiUrl(`${url.origin}${url.pathname === '/' ? '/api/v1' : url.pathname}`);
}

/**
 * `login`: asks for the password in the user's terminal and stores a token instead (src/login.ts). The URL and the
 * username come from TAIGA_API_URL / TAIGA_USERNAME when set; the password is never read from the environment.
 */
async function runLogin(run: Run): Promise<number> {
  const { env, options, secrets } = run;
  if (!isTerminal()) {
    throw new LoginError('taigent login reads your password from a terminal: run `npx taigent login` in your own terminal window, not through an agent or a pipe');
  }
  if (env.TAIGA_API_URL) print(run, `Taiga API URL: ${env.TAIGA_API_URL} (from TAIGA_API_URL)\n`);
  const apiUrl = loginApiUrl(env.TAIGA_API_URL || (await ask('Taiga API URL (e.g. https://taiga.example.com/api/v1): ')));
  if (env.TAIGA_USERNAME) print(run, `Username: ${env.TAIGA_USERNAME} (from TAIGA_USERNAME)\n`);
  const username = env.TAIGA_USERNAME || (await ask('Username or email: '));
  if (!username) throw new UsageError('no username entered');
  const password = await askHidden('Password (not shown): ');
  if (!password) throw new UsageError('no password entered');
  secrets.add(password);

  let stored;
  try {
    stored = await storeLogin({ env, apiUrl, username, password, application: options.application, secrets });
  } catch (error) {
    if (error instanceof TaigaAuthError && error.credential === 'password') {
      throw new TaigaError(`Taiga at ${apiUrl} refused the username or password`, error.status);
    }
    throw error;
  }
  const what =
    stored.record.method === 'application-token'
      ? `an application token of Application ${stored.record.application}`
      : 'a refresh token (log in again when taigent has not been used for its lifetime, 8 days by default)';
  print(run, `Logged in to ${apiUrl} as ${username}.\nStored ${what} in ${stored.storeLabel}; your password was not stored.\n`);
  return ExitCode.Ok;
}

/** `logout`: deletes the stored login; an application token is deleted on Taiga too. */
async function runLogout(run: Run): Promise<number> {
  const removed = await removeLogin(run.env, run.secrets);
  if (!removed) {
    print(run, 'Not logged in: there is no stored login to remove.\n');
    return ExitCode.Ok;
  }
  const { record, revoked } = removed;
  const onTaiga =
    record.method === 'application-token'
      ? ` Deleted ${revoked} application token(s) on Taiga.`
      : ' Taiga cannot revoke a refresh token: the deleted one would stop working after its lifetime (8 days by default).';
  print(run, `Removed the login to ${record.apiUrl} as ${record.username}.${onTaiga}\n`);
  return ExitCode.Ok;
}

/** `whoami`: which Taiga user the credentials of this run act as, checked with `GET /users/me`. */
async function runWhoami(run: Run): Promise<number> {
  const auth = await resolveAuth(run);
  const me = await (await connectTaiga(run, auth)).getMe();
  const [credentials, described] =
    auth.source === 'login'
      ? [{ source: 'login', method: auth.session.record.method, store: auth.session.storeLabel }, `stored login (${auth.session.record.method}, in ${auth.session.storeLabel})`]
      : [{ source: 'environment', variables: auth.credentials ? 'TAIGA_USERNAME, TAIGA_PASSWORD' : 'TAIGA_TOKEN' }, `environment (${auth.credentials ? 'TAIGA_USERNAME, TAIGA_PASSWORD' : 'TAIGA_TOKEN'})`];
  emit(run, { apiUrl: auth.apiUrl, user: { id: me.id, username: me.username }, credentials }, () =>
    `Taiga: ${auth.apiUrl}\nUser: ${me.username} (id ${me.id})\nCredentials: ${described}\n`,
  );
  return ExitCode.Ok;
}

/**
 * `mcp`: the Taiga MCP server on stdin/stdout. With TAIGA_USERNAME/TAIGA_PASSWORD it logs in itself; with the stored
 * login or TAIGA_TOKEN it goes through the local proxy of src/mcp.ts and never sees a real credential.
 */
async function runMcp(run: Run): Promise<number> {
  const auth = await resolveAuth(run);
  if (auth.source === 'environment' && auth.credentials) {
    await serveMcp({ TAIGA_API_URL: auth.apiUrl, TAIGA_USERNAME: auth.credentials.username, TAIGA_PASSWORD: auth.credentials.password });
    return ExitCode.Ok;
  }
  const authorizer: TaigaAuthorizer =
    auth.source === 'login' ? auth.session : { credential: 'token', authorization: () => `Bearer ${auth.token!}`, renew: async () => false };
  const proxy = await startProxy({ apiUrl: auth.apiUrl, authorizer, secrets: run.secrets, log: (text) => printError(run.secrets, text) });
  try {
    const username = auth.source === 'login' ? auth.session.record.username : 'taigent';
    await serveMcp({ TAIGA_API_URL: proxy.url, TAIGA_USERNAME: username, TAIGA_PASSWORD: proxy.password });
  } finally {
    await proxy.close();
  }
  return ExitCode.Ok;
}

function dispatch(run: Run): Promise<number> {
  switch (run.options.command) {
    case 'init':
      return runInit(run);
    case 'validate':
      return runValidate(run);
    case 'preview':
      return runPreview(run);
    case 'bootstrap':
      return runBootstrap(run);
    case 'upload':
      return runUpload(run);
    case 'skills':
      return runSkills(run);
    case 'tickets':
      return runTickets(run);
    case 'projects':
      return runProjects(run);
    case 'report':
      return runReport(run);
    case 'status':
      return runStatus(run);
    case 'comment':
      return runComment(run);
    case 'notify':
      return runNotify(run);
    case 'plan':
    case 'apply':
      return runPlan(run);
    case 'adopt':
      return runAdopt(run);
    case 'login':
      return runLogin(run);
    case 'logout':
      return runLogout(run);
    case 'whoami':
      return runWhoami(run);
    case 'mcp':
      return runMcp(run);
  }
}

function fail(secrets: Secrets, code: ExitCode, kind: string, error: Error, json: boolean, extra: Record<string, unknown> = {}): number {
  printError(secrets, `taigent: ${error.message}\n`);
  if (json) process.stdout.write(secrets.redact(`${JSON.stringify({ error: { kind, message: error.message, ...extra } }, null, 2)}\n`));
  return code;
}

/**
 * Runs the CLI and returns the process exit code. Variables missing from `processEnv` are read from `<cwd>/.env`.
 */
export async function main(argv: string[], processEnv: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> {
  const json = argv.includes('--json');
  let secrets = environmentSecrets(processEnv);
  try {
    const env = withDotEnv(processEnv, cwd);
    secrets = environmentSecrets(env);
    const options = parseOptions(argv);
    if (options === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return ExitCode.Ok;
    }
    const run = { options, env, cwd, secrets };
    refuseReadOnlyWrite(run);
    return await dispatch(run);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(json ? '' : `${USAGE}\n\n`);
      return fail(secrets, ExitCode.Usage, 'usage', error, json);
    }
    if (error instanceof ManifestError) {
      // Report manifest files relative to the working directory, as the user wrote them.
      const relativeError = new ManifestError(error.issues.map((issue) => ({ ...issue, file: relative(cwd, issue.file) })));
      return fail(secrets, ExitCode.Validation, 'validation', relativeError, json, { issues: relativeError.issues });
    }
    if (error instanceof TaigaConflictError) {
      return fail(secrets, ExitCode.Taiga, 'conflict', error, json, { status: error.status ?? null, key: error.key ?? null });
    }
    if (error instanceof UploadTooLargeError) {
      return fail(secrets, ExitCode.Taiga, 'taiga', error, json, { status: error.status ?? null, file: error.file });
    }
    if (error instanceof LoginError) return fail(secrets, ExitCode.Usage, 'login', error, json);
    if (error instanceof ReadOnlyError) return fail(secrets, ExitCode.Usage, 'read-only', error, json);
    if (error instanceof PromptCancelled) return fail(secrets, ExitCode.Usage, 'usage', new UsageError('login cancelled'), json);
    if (error instanceof TicketError || error instanceof NotifyConfigError || error instanceof InitError || error instanceof AdoptError) {
      return fail(secrets, ExitCode.Usage, 'usage', error, json);
    }
    if (error instanceof TelegramError) return fail(secrets, ExitCode.Taiga, 'telegram', error, json);
    if (error instanceof TaigaAuthError) {
      const hint = { token: 'check TAIGA_TOKEN', password: 'check TAIGA_USERNAME and TAIGA_PASSWORD', login: LOGIN_HINT }[error.credential];
      const hinted = new TaigaAuthError(error.credential, `${error.message} (${hint})`, error.status);
      return fail(secrets, ExitCode.Taiga, 'taiga', hinted, json, { status: error.status ?? null });
    }
    if (error instanceof TaigaError) return fail(secrets, ExitCode.Taiga, 'taiga', error, json, { status: error.status ?? null });
    printError(secrets, `taigent: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return ExitCode.Internal;
  }
}

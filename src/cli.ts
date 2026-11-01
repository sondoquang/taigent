// CLI: argument parsing, wiring of Manifest → Taiga client → Planner → Executor, output and exit codes.

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { describeBootstrapOperation, executeBootstrap, planBootstrap, readBootstrapRemote } from './bootstrap.ts';
import { ExitCode } from './exit-codes.ts';
import { describeAppliedOperation, executePlan } from './executor.ts';
import { errorMessage } from './guards.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { manifestsRoot, projectLayout } from './manifest/layout.ts';
import { listProjectSlugs, loadManifests, type LoadedProject } from './manifest/manifests.ts';
import type { Action, PlanSummary, Result } from './operations.ts';
import { buildPlan, describePlanOperation, type Plan } from './planner.ts';
import { readBacklogRemote } from './remote.ts';
import { Secrets } from './secrets.ts';
import { compareSkills, SKILLS_SOURCE, SKILLS_TARGET, SkillsSourceMissingError, syncSkills } from './skills.ts';
import { TaigaAuthError, TaigaClient, TaigaConflictError, TaigaError } from './taiga/client.ts';
import { describeUploadOperation, executeUpload, planUpload, readUploadRemote, UploadTooLargeError } from './upload.ts';

const USAGE = `Usage: taigent <command> [--project <slug>] [options]

Commands:
  validate  Check manifests against the conventions, offline (all projects without --project)
  bootstrap Create or complete the Taiga project declared in project.yaml (requires --yes)
  plan      Show what apply would change on Taiga (exit 3 when there are changes)
  apply     Apply the manifest to Taiga (requires --yes)
  upload    Upsert the wiki pages and attachments declared in docs.yaml (requires --yes)
  skills sync   Copy the Taigent skills (taiga-*, ask-taigent) from ${SKILLS_SOURCE} to ${SKILLS_TARGET} (run from the repository root)
  skills check  Compare them (exit 3 when the copies differ)

Options:
  --project <slug>  Taiga project slug; manifests are read from <manifests>/<slug>/
  --json            Machine-readable output on stdout
  --yes             Confirm writes (bootstrap, apply, upload)
  --dry-run         List the operations without writing anything (exit 3 when there are changes)
  -h, --help        Show this help

Environment (a variable not set in the environment is read from ./.env):
  TAIGA_API_URL                    Taiga API base URL (includes /api/v1)
  TAIGA_USERNAME, TAIGA_PASSWORD   Login; also the fallback when TAIGA_TOKEN is rejected
  TAIGA_TOKEN                      Access token used instead of username/password
  TAIGENT_MANIFESTS_DIR            Manifests root (default: ./taiga)
  TAIGENT_RETRY_UNIT_MS            Milliseconds per second of 429 backoff (default: 1000)

Exit codes: 0 ok/no changes, 1 internal error, 2 usage/config error (incl. changes without --yes),
            3 plan/--dry-run/skills check has changes, 4 manifest invalid, 5 Taiga/network error`;

const COMMANDS = ['validate', 'bootstrap', 'plan', 'apply', 'upload', 'skills'] as const;
const SKILLS_ACTIONS = ['sync', 'check'] as const;
type SkillsAction = (typeof SKILLS_ACTIONS)[number];
type Command = (typeof COMMANDS)[number];

/** Bad usage or configuration. Maps to ExitCode.Usage. */
class UsageError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface Options {
  command: Command;
  /** Required by every command except `validate` and `skills`. */
  project?: string;
  /** `skills` subcommand. */
  skillsAction?: SkillsAction;
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
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  if (values.project === undefined) {
    if (command !== 'validate' && command !== 'skills') throw new UsageError('--project <slug> is required');
  } else if (!SLUG_PATTERN.test(values.project)) {
    throw new UsageError(`invalid project slug "${values.project}"`);
  }
  return {
    command: command as Command,
    project: values.project,
    skillsAction,
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

/**
 * Connects to Taiga from the environment: TAIGA_TOKEN when set (username/password, if also set, are
 * the fallback when Taiga rejects it), else a TAIGA_USERNAME/TAIGA_PASSWORD login.
 */
async function connectTaiga({ env, secrets }: Run): Promise<TaigaClient> {
  const [apiUrl] = requireEnv(env, ['TAIGA_API_URL']);
  const url = URL.canParse(apiUrl!) ? new URL(apiUrl!) : undefined;
  if (url?.username || url?.password) {
    throw new UsageError('TAIGA_API_URL must not contain credentials (user:password@); set TAIGA_USERNAME and TAIGA_PASSWORD (or TAIGA_TOKEN) instead');
  }
  const token = env.TAIGA_TOKEN || undefined;
  const missing = ['TAIGA_USERNAME', 'TAIGA_PASSWORD'].filter((name) => !env[name]);
  if (!token && missing.length > 0) {
    throw new UsageError(`missing environment variable(s): ${missing.join(', ')} (or set TAIGA_TOKEN instead)`);
  }
  const credentials = missing.length === 0 ? { username: env.TAIGA_USERNAME!, password: env.TAIGA_PASSWORD! } : undefined;
  return TaigaClient.connect({ apiUrl: apiUrl!, token, credentials, retryUnitMs: retryUnitMs(env), secrets });
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

const MARKER: Record<Action, string> = { create: '  + ', update: '  ~ ', link: '  + ', skip: '    skip ' };

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

/** The parts of a backlog plan that are reported but never acted on: orphans and stale epic links. */
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

/** Validates one project's manifests, or every project under the manifests root. Offline: no env needed. */
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
    try {
      projects.push(await loadManifests(projectLayout(slug, env, cwd).dir, slug));
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
  const plan = buildPlan(backlog, remote);

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

function dispatch(run: Run): Promise<number> {
  switch (run.options.command) {
    case 'validate':
      return runValidate(run);
    case 'bootstrap':
      return runBootstrap(run);
    case 'upload':
      return runUpload(run);
    case 'skills':
      return runSkills(run);
    case 'plan':
    case 'apply':
      return runPlan(run);
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
    return await dispatch({ options, env, cwd, secrets });
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
    if (error instanceof TaigaAuthError) {
      const check = error.credential === 'token' ? 'TAIGA_TOKEN' : 'TAIGA_USERNAME and TAIGA_PASSWORD';
      const hinted = new TaigaAuthError(error.credential, `${error.message} (check ${check})`, error.status);
      return fail(secrets, ExitCode.Taiga, 'taiga', hinted, json, { status: error.status ?? null });
    }
    if (error instanceof TaigaError) return fail(secrets, ExitCode.Taiga, 'taiga', error, json, { status: error.status ?? null });
    printError(secrets, `taigent: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return ExitCode.Internal;
  }
}

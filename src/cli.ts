// CLI: argument parsing, wiring of Manifest → Taiga client → Planner → Executor, output and exit codes.

import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ExitCode } from './exit-codes.ts';
import { errorMessage } from './guards.ts';
import { ApplyConflictError, executePlan, type ApplyReport } from './executor.ts';
import { loadBacklog } from './manifest/backlog.ts';
import { ManifestError } from './manifest/errors.ts';
import { projectLayout } from './manifest/layout.ts';
import { buildPlan, srcTag, type Operation, type Plan } from './planner.ts';
import { TaigaAuthError, TaigaClient, TaigaError } from './taiga/client.ts';

const USAGE = `Usage: taigent <command> --project <slug> [options]

Commands:
  plan     Show what apply would change on Taiga (exit 3 when there are changes)
  apply    Apply the manifest to Taiga (requires --yes)

Options:
  --project <slug>  Taiga project slug; manifests are read from <manifests>/<slug>/
  --json            Machine-readable output on stdout
  --yes             Confirm writes (apply)
  -h, --help        Show this help

Environment:
  TAIGA_API_URL                    Taiga API base URL (includes /api/v1)
  TAIGA_USERNAME, TAIGA_PASSWORD   Login; also the fallback when TAIGA_TOKEN is rejected
  TAIGA_TOKEN                      Access token used instead of username/password
  TAIGENT_MANIFESTS_DIR            Manifests root (default: ./taiga)
  TAIGENT_RETRY_UNIT_MS            Milliseconds per second of 429 backoff (default: 1000)

Exit codes: 0 ok/no changes, 1 internal error, 2 usage/config error,
            3 plan has changes, 4 manifest invalid, 5 Taiga/network error`;

const COMMANDS = ['plan', 'apply'] as const;
type Command = (typeof COMMANDS)[number];

/** Bad usage or configuration. Maps to ExitCode.Usage. */
class UsageError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface Options {
  command: Command;
  project: string;
  json: boolean;
  yes: boolean;
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
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  if (!values.project) throw new UsageError('--project <slug> is required');
  if (!SLUG_PATTERN.test(values.project)) throw new UsageError(`invalid project slug "${values.project}"`);
  return { command: command as Command, project: values.project, json: values.json, yes: values.yes };
}

function requireEnv(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new UsageError(`missing environment variable(s): ${missing.join(', ')}`);
  return names.map((name) => env[name]!);
}

function formatOperation(op: Operation): string {
  switch (op.action) {
    case 'create':
      return `  + create ${op.type} ${op.key}  "${op.fields.subject}"${op.parent ? `  (in ${op.type === 'task' ? 'story' : 'epic'} ${op.parent})` : ''}`;
    case 'update':
      return `  ~ update ${op.type} ${op.key}  (#${op.ref}, id ${op.id}): ${Object.keys(op.changes).join(', ')}`;
    case 'link':
      return `  + link   story ${op.key} -> epic ${op.epic}`;
    case 'skip':
      return `    skip   ${op.type} ${op.key}  (#${op.ref}, id ${op.id}, unchanged)`;
  }
}

/**
 * Connects to Taiga from the environment: TAIGA_TOKEN when set (username/password, if also set, are
 * the fallback when Taiga rejects it), else a TAIGA_USERNAME/TAIGA_PASSWORD login.
 */
async function connectTaiga(env: NodeJS.ProcessEnv): Promise<TaigaClient> {
  const [apiUrl] = requireEnv(env, ['TAIGA_API_URL']);
  const token = env.TAIGA_TOKEN || undefined;
  const missing = ['TAIGA_USERNAME', 'TAIGA_PASSWORD'].filter((name) => !env[name]);
  if (!token && missing.length > 0) {
    throw new UsageError(`missing environment variable(s): ${missing.join(', ')} (or set TAIGA_TOKEN instead)`);
  }
  const credentials = missing.length === 0 ? { username: env.TAIGA_USERNAME!, password: env.TAIGA_PASSWORD! } : undefined;
  return TaigaClient.connect({ apiUrl: apiUrl!, token, credentials, retryUnitMs: retryUnitMs(env) });
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

function formatPlan(plan: Plan): string {
  const lines = [`Plan for project ${plan.project.slug} (id ${plan.project.id}):`];
  lines.push(...plan.operations.map(formatOperation));
  if (plan.operations.length === 0) lines.push('  (manifest has no items)');
  if (plan.orphans.length > 0) {
    lines.push('Orphans (tagged src: on Taiga but not in the manifest; never deleted):');
    for (const orphan of plan.orphans) {
      lines.push(`  ! orphan ${orphan.type} ${orphan.key}  (#${orphan.ref}, id ${orphan.id})  "${orphan.subject}"`);
    }
  }
  const { create, update, link, skip } = plan.summary;
  lines.push(
    plan.changes
      ? `${create} to create, ${update} to update, ${link} to link, ${skip} unchanged.`
      : 'No changes. Taiga matches the manifest.',
  );
  return `${lines.join('\n')}\n`;
}

function formatReport(report: ApplyReport): string {
  const lines = [`Applied to project ${report.project.slug} (id ${report.project.id}):`];
  for (const op of report.operations) {
    if (op.result === 'created') lines.push(`  + created ${op.type} ${op.key}  #${op.ref} (id ${op.id})`);
    if (op.result === 'updated') lines.push(`  ~ updated ${op.type} ${op.key}  #${op.ref} (id ${op.id})`);
    if (op.result === 'linked') lines.push(`  + linked  story ${op.key} -> epic ${op.epic}`);
  }
  const { created, updated, linked, unchanged } = report.summary;
  lines.push(`${created} created, ${updated} updated, ${linked} linked, ${unchanged} unchanged.`);
  return `${lines.join('\n')}\n`;
}

async function run(options: Options, env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const layout = projectLayout(options.project, env, cwd);
  const backlog = await loadBacklog(layout.backlog);
  const client = await connectTaiga(env);
  const project = await client.getProjectBySlug(options.project);
  const [epics, stories, tasks] = await Promise.all([
    client.listEpics(project.id),
    client.listUserStories(project.id),
    client.listTasks(project.id),
  ]);
  // Existing links only matter for manifest epics that have stories.
  const epicTagsWithStories = new Set(backlog.epics.filter((epic) => epic.stories.length > 0).map((epic) => srcTag(epic.key)));
  const epicStories = new Map<number, number[]>();
  for (const epic of epics) {
    if (epic.tags.some((tag) => epicTagsWithStories.has(tag))) epicStories.set(epic.id, await client.listEpicUserStories(epic.id));
  }
  const plan = buildPlan(backlog, { project: { id: project.id, slug: project.slug }, epics, stories, tasks, epicStories });

  if (options.command === 'plan' || !options.yes) {
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatPlan(plan));
    if (!plan.changes) return ExitCode.Ok;
    if (options.command === 'plan') return ExitCode.Changes;
    throw new UsageError('refusing to apply without --yes; review the plan above, then re-run with --yes');
  }

  const report = await executePlan(plan, client, layout.state);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return ExitCode.Ok;
}

function fail(code: ExitCode, kind: string, error: Error, json: boolean, extra: Record<string, unknown> = {}): number {
  process.stderr.write(`taigent: ${error.message}\n`);
  if (json) process.stdout.write(`${JSON.stringify({ error: { kind, message: error.message, ...extra } }, null, 2)}\n`);
  return code;
}

/** Runs the CLI and returns the process exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<number> {
  const json = argv.includes('--json');
  try {
    const options = parseOptions(argv);
    if (options === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return ExitCode.Ok;
    }
    return await run(options, env, cwd);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(json ? '' : `${USAGE}\n\n`);
      return fail(ExitCode.Usage, 'usage', error, json);
    }
    if (error instanceof ManifestError) {
      // Report manifest files relative to the working directory, as the user wrote them.
      const relativeError = new ManifestError(error.issues.map((issue) => ({ ...issue, file: relative(cwd, issue.file) })));
      return fail(ExitCode.Validation, 'validation', relativeError, json, { issues: relativeError.issues });
    }
    if (error instanceof ApplyConflictError) {
      return fail(ExitCode.Taiga, 'conflict', error, json, { status: error.status ?? null, key: error.key });
    }
    if (error instanceof TaigaAuthError) {
      const check = error.credential === 'token' ? 'TAIGA_TOKEN' : 'TAIGA_USERNAME and TAIGA_PASSWORD';
      const hinted = new TaigaAuthError(error.credential, `${error.message} (check ${check})`, error.status);
      return fail(ExitCode.Taiga, 'taiga', hinted, json, { status: error.status ?? null });
    }
    if (error instanceof TaigaError) return fail(ExitCode.Taiga, 'taiga', error, json, { status: error.status ?? null });
    process.stderr.write(`taigent: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return ExitCode.Internal;
  }
}

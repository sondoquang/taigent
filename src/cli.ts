// CLI: argument parsing, wiring of Manifest → Taiga client → Planner → Executor, output and exit codes.

import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ExitCode } from './exit-codes.ts';
import { errorMessage } from './guards.ts';
import { executePlan, type ApplyReport } from './executor.ts';
import { ManifestError, type ManifestIssue } from './manifest/errors.ts';
import { manifestsRoot, projectLayout } from './manifest/layout.ts';
import { listProjectSlugs, loadManifests, type LoadedProject } from './manifest/manifests.ts';
import { buildPlan, type Plan } from './planner.ts';
import { TaigaClient, TaigaError } from './taiga/client.ts';

const USAGE = `Usage: taigent <command> [--project <slug>] [options]

Commands:
  validate Check manifests against the conventions, offline (all projects without --project)
  plan     Show what apply would change on Taiga (exit 3 when there are changes)
  apply    Apply the manifest to Taiga (requires --yes)

Options:
  --project <slug>  Taiga project slug; manifests are read from <manifests>/<slug>/
  --json            Machine-readable output on stdout
  --yes             Confirm writes (apply)
  -h, --help        Show this help

Environment:
  TAIGA_API_URL, TAIGA_USERNAME, TAIGA_PASSWORD   Taiga connection (URL includes /api/v1)
  TAIGENT_MANIFESTS_DIR                           Manifests root (default: ./taiga)

Exit codes: 0 ok/no changes, 1 internal error, 2 usage/config error,
            3 plan has changes, 4 manifest invalid, 5 Taiga/network error`;

const COMMANDS = ['validate', 'plan', 'apply'] as const;
type Command = (typeof COMMANDS)[number];

/** Bad usage or configuration. Maps to ExitCode.Usage. */
class UsageError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface Options {
  command: Command;
  /** Required by every command except `validate`. */
  project?: string;
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
  if (values.project === undefined) {
    if (command !== 'validate') throw new UsageError('--project <slug> is required');
  } else if (!SLUG_PATTERN.test(values.project)) {
    throw new UsageError(`invalid project slug "${values.project}"`);
  }
  return { command: command as Command, project: values.project, json: values.json, yes: values.yes };
}

function requireEnv(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) throw new UsageError(`missing environment variable(s): ${missing.join(', ')}`);
  return names.map((name) => env[name]!);
}

function formatPlan(plan: Plan): string {
  const lines = [`Plan for project ${plan.project.slug} (id ${plan.project.id}):`];
  for (const op of plan.operations) {
    lines.push(
      op.action === 'create'
        ? `  + create epic ${op.key}  "${op.fields.subject}"`
        : `    skip   epic ${op.key}  (#${op.ref}, id ${op.id}, unchanged)`,
    );
  }
  if (plan.operations.length === 0) lines.push('  (manifest has no items)');
  lines.push(
    plan.changes
      ? `${plan.summary.create} to create, ${plan.summary.skip} unchanged.`
      : 'No changes. Taiga matches the manifest.',
  );
  return `${lines.join('\n')}\n`;
}

function formatReport(report: ApplyReport): string {
  const lines = [`Applied to project ${report.project.slug} (id ${report.project.id}):`];
  for (const op of report.operations) {
    if (op.result === 'created') lines.push(`  + created epic ${op.key}  #${op.ref} (id ${op.id})`);
  }
  lines.push(`${report.summary.created} created, ${report.summary.unchanged} unchanged.`);
  return `${lines.join('\n')}\n`;
}

/** Validates one project's manifests, or every project under the manifests root. Offline: no env needed. */
async function runValidate(options: Options, env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
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
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ valid: true, projects: report }, null, 2)}\n`
      : `${report.flatMap(({ files }) => files.map((file) => `${file}: ok`)).join('\n')}\nAll manifests follow the conventions.\n`,
  );
  return ExitCode.Ok;
}

async function run(options: Options, env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  if (options.command === 'validate') return runValidate(options, env, cwd);
  const slug = options.project!;
  const layout = projectLayout(slug, env, cwd);
  const backlog = (await loadManifests(layout.dir, slug, { require: ['backlog'] })).manifests.backlog!;
  const [apiUrl, username, password] = requireEnv(env, ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD']);
  const client = await TaigaClient.login({ apiUrl: apiUrl!, username: username!, password: password! });
  const project = await client.getProjectBySlug(slug);
  const epics = await client.listEpics(project.id);
  const plan = buildPlan(backlog, { project: { id: project.id, slug: project.slug }, epics });

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
    if (error instanceof TaigaError) return fail(ExitCode.Taiga, 'taiga', error, json, { status: error.status ?? null });
    process.stderr.write(`taigent: internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
    return ExitCode.Internal;
  }
}

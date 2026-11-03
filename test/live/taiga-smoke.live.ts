// Opt-in live smoke test against a REAL Taiga project (runbook: docs/live-smoke.md). It writes data, so it is
// skipped unless TAIGENT_LIVE_SMOKE=1, the target project is never defaulted (TAIGENT_SMOKE_PROJECT), and it is
// not part of `npm test` (run it with `npm run test:live`). test/live-smoke.test.ts runs it against the fake.
//
// One run creates two epics, a story linked to the first epic, a task under the story, a wiki page and two
// small attachments (epic + wiki page), all keyed with a unique run prefix, through `taigent apply/upload --yes`.
// It checks them over REST, re-runs both commands and requires `plan`/`upload --dry-run` to report no change
// and REST to still show exactly one of each. It also reports the answers to two open questions: whether
// GET /epics filters by tag on the server, and (TAIGENT_SMOKE_UPLOAD_PROBE_BYTES) whether an upload of that
// size passes the reverse proxy.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { isRecord } from '../../src/guards.ts';
import { TaigaClient, type TaigaAttachment, type TaigaConnectOptions, type TaigaItem } from '../../src/taiga/client.ts';
import { runTaigent, type CliResult } from '../support/harness.ts';

const ENABLED = process.env.TAIGENT_LIVE_SMOKE === '1';
const DISABLED = 'set TAIGENT_LIVE_SMOKE=1 to run it (it writes to a real Taiga project, see docs/live-smoke.md)';

/** Unique per run, so items of earlier runs never match (they show up as orphans in `plan`, which is fine). */
const RUN = Date.now().toString(36);
const PREFIX = `SMOKE-${RUN.toUpperCase()}`;
const KEY = { epic: `${PREFIX}-EPIC`, epic2: `${PREFIX}-EPIC2`, story: `${PREFIX}-STORY`, task: `${PREFIX}-TASK` };
const WIKI_SLUG = `smoke-${RUN}`;
const WIKI_CONTENT = `# taigent live smoke ${RUN}\n\nCreated by test/live/taiga-smoke.live.ts. Safe to delete.\n`;
const EPIC_FILE = `smoke-${RUN}-epic.txt`;
const WIKI_FILE = `smoke-${RUN}-wiki.txt`;
const EPIC_BYTES = Buffer.from(`taigent live smoke ${RUN}: epic attachment\n`);
const WIKI_BYTES = Buffer.from(`taigent live smoke ${RUN}: wiki attachment, UTF-8 đ ✓\n`);

const BACKLOG = `epics:
  - key: ${KEY.epic}
    subject: Smoke ${RUN} epic
    description: Created by the taigent live smoke test. Safe to delete.
    tags: [type:chore]
    stories:
      - key: ${KEY.story}
        subject: Smoke ${RUN} story
        use_case:
          as_a: taigent maintainer
          i_want_to: create a story on a real Taiga
          so_that: I know apply works against the live API
        description: Created by the taigent live smoke test. Safe to delete.
        scenarios:
          - scenario: Story linked to its epic
            given: [the smoke backlog is applied]
            when: the smoke test reads the epic's related stories
            then: this story is among them
        tags: [type:chore]
        tasks:
          - key: ${KEY.task}
            subject: Smoke ${RUN} task
            description: Done when the smoke test finds it under its story.
  - key: ${KEY.epic2}
    subject: Smoke ${RUN} second epic
    description: Lets the smoke test tell whether GET /epics filters by tag on the server.
`;

const DOCS = `wiki:
  - slug: ${WIKI_SLUG}
    file: pages/${WIKI_SLUG}.md
attachments:
  - target: ${KEY.epic}
    file: files/${EPIC_FILE}
    description: taigent live smoke ${RUN}
  - target: wiki:${WIKI_SLUG}
    file: files/${WIKI_FILE}
    description: taigent live smoke ${RUN}
`;

interface LiveConfig {
  slug: string;
  connection: TaigaConnectOptions;
  /** TAIGA_* / TAIGENT_RETRY_UNIT_MS passed to the CLI (the harness strips them from the inherited env). */
  cliEnv: Record<string, string>;
}

/** The target and credentials; an enabled run never falls back to a default project. */
function liveConfig(): LiveConfig {
  const env = process.env;
  const missing: string[] = [];
  if (!env.TAIGENT_SMOKE_PROJECT) missing.push('TAIGENT_SMOKE_PROJECT (slug of the Taiga project to write to)');
  if (!env.TAIGA_API_URL) missing.push('TAIGA_API_URL');
  if (!env.TAIGA_TOKEN && !(env.TAIGA_USERNAME && env.TAIGA_PASSWORD)) missing.push('TAIGA_USERNAME and TAIGA_PASSWORD (or TAIGA_TOKEN)');
  if (missing.length > 0) throw new Error(`live smoke test enabled (TAIGENT_LIVE_SMOKE=1) but missing: ${missing.join('; ')}`);
  const cliEnv: Record<string, string> = {};
  for (const name of ['TAIGA_API_URL', 'TAIGA_TOKEN', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGENT_RETRY_UNIT_MS']) {
    if (env[name]) cliEnv[name] = env[name];
  }
  return {
    slug: env.TAIGENT_SMOKE_PROJECT!,
    connection: {
      apiUrl: env.TAIGA_API_URL!,
      token: env.TAIGA_TOKEN || undefined,
      credentials: env.TAIGA_USERNAME && env.TAIGA_PASSWORD ? { username: env.TAIGA_USERNAME, password: env.TAIGA_PASSWORD } : undefined,
      retryUnitMs: env.TAIGENT_RETRY_UNIT_MS ? Number(env.TAIGENT_RETRY_UNIT_MS) : undefined,
    },
    cliEnv,
  };
}

/** A temp working directory (removed after the test) holding `taiga/<slug>/`. */
async function workDir(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'taigent-live-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

async function writeProjectFile(cwd: string, slug: string, path: string, content: string | Uint8Array): Promise<void> {
  const absolute = join(cwd, 'taiga', slug, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/** Runs the real CLI on the target project and requires exit code 0. */
async function taigent(config: LiveConfig, cwd: string, args: string[]): Promise<CliResult> {
  const result = await runTaigent([...args, '--project', config.slug], { env: config.cliEnv, cwd });
  assert.equal(result.code, 0, `taigent ${args.join(' ')} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

const srcTag = (key: string) => `src:${key.toLowerCase()}`;

/** The single item tagged `src:<key>`; zero or several fail (missing item or duplicate). */
function only<T extends TaigaItem>(items: T[], key: string): T {
  const found = items.filter((item) => item.tags.includes(srcTag(key)));
  assert.equal(found.length, 1, `expected exactly one item tagged ${srcTag(key)}, found ${found.length}`);
  return found[0]!;
}

/** The single attachment named `name`, with the local file's size and sha1. */
function onlyAttachment(attachments: TaigaAttachment[], name: string, bytes: Buffer): TaigaAttachment {
  const found = attachments.filter((a) => a.name === name);
  assert.equal(found.length, 1, `expected exactly one attachment named ${name}, found ${found.length}`);
  assert.equal(found[0]!.size, bytes.length, `size of ${name}`);
  assert.equal(found[0]!.sha1, createHash('sha1').update(bytes).digest('hex'), `sha1 of ${name}`);
  return found[0]!;
}

/** Reads everything the run created back over REST and checks links, parents, wiki page and attachments. */
async function verifyRemote(client: TaigaClient, projectId: number) {
  const epics = await client.listItems('epic', projectId);
  const epic = only(epics, KEY.epic);
  only(epics, KEY.epic2);
  const story = only(await client.listItems('story', projectId), KEY.story);
  const task = only(await client.listItems('task', projectId), KEY.task);
  assert.ok((await client.listEpicUserStories(epic.id)).includes(story.id), `story ${KEY.story} is not linked to epic ${KEY.epic}`);
  assert.equal(task.userStory, story.id, `task ${KEY.task} is not under story ${KEY.story}`);
  const page = await client.findWikiPage(projectId, WIKI_SLUG);
  assert.ok(page, `wiki page ${WIKI_SLUG} not found`);
  assert.equal(page.content, WIKI_CONTENT);
  onlyAttachment(await client.listAttachments('epic', projectId, epic.id), EPIC_FILE, EPIC_BYTES);
  onlyAttachment(await client.listAttachments('wiki', projectId, page.id), WIKI_FILE, WIKI_BYTES);
  return { epics, epic, story, task, page };
}

/**
 * Open question: does GET /epics filter by `tags` on the server? (taigent assumes not and filters client-side.)
 * TaigaClient deliberately has no such query, so this is a plain authenticated GET.
 */
async function epicTagFilter(config: LiveConfig, projectId: number, epic: TaigaItem, allEpics: number): Promise<string> {
  const { apiUrl: base, token: configuredToken, credentials } = config.connection;
  const apiUrl = base.replace(/\/+$/, '');
  let token = configuredToken;
  if (token === undefined) {
    const auth = await fetch(`${apiUrl}/auth`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'normal', ...credentials }),
    });
    assert.equal(auth.status, 200, `POST /auth: HTTP ${auth.status}`);
    const body: unknown = await auth.json();
    assert.ok(isRecord(body) && typeof body.auth_token === 'string', 'POST /auth returned no auth_token');
    token = body.auth_token;
  }
  const query = `project=${projectId}&tags=${srcTag(KEY.epic)}`;
  const response = await fetch(`${apiUrl}/epics?${query}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'x-disable-pagination': 'True' },
  });
  assert.equal(response.status, 200, `GET /epics?${query}: HTTP ${response.status}`);
  const list: unknown = await response.json();
  assert.ok(Array.isArray(list), `GET /epics?${query} did not return a list`);
  const ids = list.map((e: unknown) => (isRecord(e) ? e.id : undefined));
  const verdict =
    ids.length === 1 && ids[0] === epic.id ? 'applied server-side' : ids.length === allEpics ? 'ignored' : 'inconclusive';
  return `epic tag filter: GET /epics?${query} returned ${ids.length} of ${allEpics} epics: ${verdict}`;
}

test('live smoke: apply + upload create linked items, wiki page and attachments; a re-run changes and duplicates nothing', { skip: ENABLED ? false : DISABLED }, async (t) => {
  const config = liveConfig();
  const cwd = await workDir(t);
  await writeProjectFile(cwd, config.slug, 'backlog.yaml', BACKLOG);
  await writeProjectFile(cwd, config.slug, 'docs.yaml', DOCS);
  await writeProjectFile(cwd, config.slug, `pages/${WIKI_SLUG}.md`, WIKI_CONTENT);
  await writeProjectFile(cwd, config.slug, `files/${EPIC_FILE}`, EPIC_BYTES);
  await writeProjectFile(cwd, config.slug, `files/${WIKI_FILE}`, WIKI_BYTES);
  t.diagnostic(`run ${RUN} on project ${config.slug}: keys ${Object.values(KEY).join(', ')}; wiki page ${WIKI_SLUG}`);

  const applied = (await taigent(config, cwd, ['apply', '--yes', '--json'])).json<{ summary: Record<string, number> }>();
  assert.deepEqual(applied.summary, { created: 4, updated: 0, adopted: 0, linked: 1, unchanged: 0 });
  const uploaded = (await taigent(config, cwd, ['upload', '--yes', '--json'])).json<{ summary: Record<string, number> }>();
  assert.deepEqual(uploaded.summary, { created: 3, updated: 0, unchanged: 0 });

  const client = await TaigaClient.connect(config.connection);
  const project = await client.getProjectBySlug(config.slug);
  const first = await verifyRemote(client, project.id);
  t.diagnostic(`check in the web UI: epic #${first.epic.ref} (story #${first.story.ref} linked, attachment ${EPIC_FILE}), task #${first.task.ref}, wiki page ${WIKI_SLUG} (attachment ${WIKI_FILE})`);
  t.diagnostic(await epicTagFilter(config, project.id, first.epic, first.epics.length));

  const reapplied = (await taigent(config, cwd, ['apply', '--yes', '--json'])).json<{ summary: Record<string, number> }>();
  const { created, updated, linked } = reapplied.summary;
  assert.deepEqual({ created, updated, linked }, { created: 0, updated: 0, linked: 0 }, 're-run of apply writes nothing');
  const reuploaded = (await taigent(config, cwd, ['upload', '--yes', '--json'])).json<{ summary: Record<string, number> }>();
  assert.deepEqual(reuploaded.summary, { created: 0, updated: 0, unchanged: 3 }, 're-run of upload writes nothing');
  assert.equal((await taigent(config, cwd, ['plan', '--json'])).json<{ changes: boolean }>().changes, false);
  assert.equal((await taigent(config, cwd, ['upload', '--dry-run', '--json'])).json<{ changes: boolean }>().changes, false);

  const second = await verifyRemote(client, project.id);
  assert.deepEqual(
    [second.epic.id, second.story.id, second.task.id, second.page.id],
    [first.epic.id, first.story.id, first.task.id, first.page.id],
    'the same items, no duplicates',
  );
});

/** TAIGENT_SMOKE_UPLOAD_PROBE_BYTES: size of the probe attachment, or undefined when the probe is off. */
const PROBE = process.env.TAIGENT_SMOKE_UPLOAD_PROBE_BYTES;

test('upload limit probe: one wiki attachment of TAIGENT_SMOKE_UPLOAD_PROBE_BYTES bytes', { skip: !ENABLED ? DISABLED : PROBE ? false : 'set TAIGENT_SMOKE_UPLOAD_PROBE_BYTES=<bytes> to probe the upload limit' }, async (t) => {
  const config = liveConfig();
  const bytes = Number(PROBE);
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, `TAIGENT_SMOKE_UPLOAD_PROBE_BYTES must be a positive integer, got "${PROBE}"`);
  const cwd = await workDir(t);
  const slug = `smoke-${RUN}-probe`;
  const name = `smoke-${RUN}-probe.bin`;
  await writeProjectFile(cwd, config.slug, 'docs.yaml', `wiki:\n  - slug: ${slug}\n    file: pages/${slug}.md\nattachments:\n  - target: wiki:${slug}\n    file: files/${name}\n`);
  await writeProjectFile(cwd, config.slug, `pages/${slug}.md`, `# taigent upload limit probe ${RUN}\n\nSafe to delete.\n`);
  await writeProjectFile(cwd, config.slug, `files/${name}`, '');
  // Sized without holding it in memory: zero-filled by extending the file.
  const file = await open(join(cwd, 'taiga', config.slug, 'files', name), 'r+');
  await file.truncate(bytes).finally(() => file.close());

  const result = await runTaigent(['upload', '--yes', '--json', '--project', config.slug], { env: config.cliEnv, cwd });

  if (result.code === 0) {
    const client = await TaigaClient.connect(config.connection);
    const project = await client.getProjectBySlug(config.slug);
    const page = await client.findWikiPage(project.id, slug);
    assert.ok(page, `wiki page ${slug} not found`);
    const sizes = (await client.listAttachments('wiki', project.id, page.id)).filter((a) => a.name === name).map((a) => a.size);
    assert.deepEqual(sizes, [bytes]);
    t.diagnostic(`upload limit: ${bytes} bytes accepted`);
  } else {
    const { error } = result.json<{ error: { status?: number } }>();
    assert.ok(result.code === 5 && error.status === 413, `upload neither succeeded nor got HTTP 413:\n${result.stdout}\n${result.stderr}`);
    t.diagnostic(`upload limit: ${bytes} bytes rejected (HTTP 413)`);
  }
});

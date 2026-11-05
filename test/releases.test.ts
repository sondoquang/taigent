import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// Releases (ADR 0005): `releases` in project.yaml checked by `validate`, `release:` tags refused in backlog.yaml, and
// the release burndown of `taigent metrics`.

const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

// UTC+7 without daylight saving, so a local day runs from 17:00Z the day before to 17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

/** The day `offset` days from today in `TZ`, YYYY-MM-DD: the seeds are relative to the real clock. */
function day(offset: number): string {
  const [year, month, date] = todayIn(TZ).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
}

/** An instant at 10:00 (local time in `TZ`) of the day `offset` days from today, ISO 8601. */
function at(offset: number): string {
  return new Date(`${day(offset)}T10:00:00+07:00`).toISOString();
}

const PROJECT_YAML = `name: Vigo - Alpha
slug: vigo-alpha
description: Alpha project.
template: scrum
modules: [epics, wiki]
`;

function issuesOf(result: { json<T>(): T }): [string, string, string][] {
  return result
    .json<{ error: { issues: ManifestIssue[] } }>()
    .error.issues.map((issue) => [issue.file.replaceAll('\\', '/'), issue.path, issue.rule]);
}

test('validate checks the releases of project.yaml: kebab-case version, YYYY-MM-DD target, no duplicate', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'vigo-alpha',
    'project.yaml',
    `${PROJECT_YAML}releases:
  - version: v1-2-0
    target: 2026-12-01
  - version: V1.3
    target: 2026-12-15
  - version: v1-4-0
    target: 2026/12/20
  - version: v1-5-0
    target: 2026-02-30
  - version: v1-2-0
    target: 2027-01-10
  - version: v1-6-0
  - target: 2027-02-01
    notes: later
  - just-a-string
`,
  );

  const result = await h.taigent(['validate', '--project', 'vigo-alpha', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const file = 'taiga/vigo-alpha/project.yaml';
  assert.deepEqual(issuesOf(result), [
    [file, 'releases[1].version', 'release-version'],
    [file, 'releases[2].target', 'release-target'],
    [file, 'releases[3].target', 'release-target'],
    [file, 'releases[4].version', 'release-unique'],
    [file, 'releases[5].target', 'release-target'],
    [file, 'releases[6].notes', 'known-field'],
    [file, 'releases[6].version', 'release-version'],
    [file, 'releases[7]', 'type'],
  ]);
  assert.deepEqual(h.fake.requests, []);
});

test('validate refuses releases that is not a list', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('vigo-alpha', 'project.yaml', `${PROJECT_YAML}releases: v1-2-0\n`);

  const result = await h.taigent(['validate', '--project', 'vigo-alpha', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  assert.deepEqual(issuesOf(result), [['taiga/vigo-alpha/project.yaml', 'releases', 'type']]);
});

test('validate accepts declared releases', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('vigo-alpha', 'project.yaml', `${PROJECT_YAML}releases:\n  - version: v1-2-0\n    target: 2026-12-01\n  - version: mvp\n    target: 2027-01-31\n`);

  const result = await h.taigent(['validate', '--project', 'vigo-alpha'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
});

test('validate refuses a release: tag in backlog.yaml like the other prefixes it does not allow', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'vigo-alpha',
    'backlog.yaml',
    `epics:
  - key: AUTH
    subject: Auth
    tags: [release:v1-2-0]
    stories:
      - key: AUTH-LOGIN
        subject: Login
        tags: [area:auth, release:v1-2-0]
`,
  );

  const result = await h.taigent(['validate', '--project', 'vigo-alpha', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const file = 'taiga/vigo-alpha/backlog.yaml';
  assert.deepEqual(issuesOf(result), [
    [file, 'epics[0].tags[0]', 'tag-prefix'],
    [file, 'epics[0].stories[0].tags[1]', 'tag-prefix'],
  ]);
  const message = result.json<{ error: { issues: ManifestIssue[] } }>().error.issues[0]!.message;
  assert.match(message, /release:/);
  assert.match(message, /project\.yaml/);
});

// ---- Release burndown ---------------------------------------------------------------------------

interface BurndownDay {
  day: string;
  remaining: number | null;
  ideal: number | null;
}

interface ReleaseJson {
  version: string;
  tag: string;
  declared: boolean;
  target: string | null;
  start: string | null;
  stories: { total: number; closed: number };
  points: { total: number; closed: number; remaining: number };
  days: BurndownDay[];
}

interface StoryRefJson {
  id: number;
  ref: number;
  subject: string;
  releases: string[];
}

interface MetricsJson {
  productOwner: { releaseBurndown: { releases: ReleaseJson[]; multiTagged: StoryRefJson[] } };
  warnings: { code: string; message: string }[];
}

function closedStatus(fake: FakeTaiga, project: number) {
  const status = fake.state.storyStatuses.find((candidate) => candidate.project === project && candidate.is_closed)!;
  return { status: status.id, status_name: status.name, is_closed: true };
}

function addStory(
  fake: FakeTaiga,
  project: number,
  subject: string,
  fields: { tags: string[]; created: number; closed?: number; points?: number | null },
): FakeUserStory {
  const { tags, created, closed, points = null } = fields;
  return Object.assign(fake.addUserStory({ project, subject, tags }), {
    ...(closed === undefined ? {} : closedStatus(fake, project)),
    created_date: at(created),
    finish_date: closed === undefined ? null : at(closed),
    total_points: points,
  });
}

/** Days `from` to `to` (offsets from today), inclusive. */
function range(from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => day(from + index));
}

test('metrics draws a burndown per release with the three release warnings, reading nothing but Taiga and project.yaml', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'vigo-alpha', name: 'Alpha', members: [h.fake.user.id] });
  await h.writeManifest(
    'vigo-alpha',
    'project.yaml',
    `${PROJECT_YAML}releases:\n  - version: v1-0-0\n    target: ${day(4)}\n  - version: v2-0-0\n    target: ${day(30)}\n`,
  );
  const p = alpha.id;
  addStory(h.fake, p, 'Login', { tags: ['release:v1-0-0', 'area:auth'], created: -4, closed: -2, points: 3 });
  addStory(h.fake, p, 'Signup', { tags: ['release:v1-0-0'], created: -2, closed: 0, points: 5 });
  addStory(h.fake, p, 'Profile', { tags: ['release:v1-0-0'], created: -3, points: 2 });
  addStory(h.fake, p, 'Unestimated', { tags: ['release:v1-0-0'], created: -1 });
  const both = addStory(h.fake, p, 'Both', { tags: ['release:v1-0-0', 'release:v2-0-0'], created: -10, points: 8 });
  addStory(h.fake, p, 'Typo', { tags: ['release:v1-0'], created: -1, closed: -1, points: 1 });
  addStory(h.fake, p, 'Typo open', { tags: ['release:v1-0'], created: -1, points: 4 });
  addStory(h.fake, p, 'No release', { tags: ['area:auth'], created: -40, points: 13 });

  const result = await h.taigent(['metrics', '--project', 'vigo-alpha', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<MetricsJson>();
  const { releases, multiTagged } = report.productOwner.releaseBurndown;
  assert.deepEqual(
    releases.map(({ version }) => version),
    ['v1-0-0', 'v2-0-0', 'v1-0'],
  );

  // v1-0-0: Both is left out; 10 points, from Login's creation (4 days ago) to the target in 4 days.
  const [v1, v2, typo] = releases as [ReleaseJson, ReleaseJson, ReleaseJson];
  assert.deepEqual(
    { ...v1, days: undefined },
    {
      version: 'v1-0-0',
      tag: 'release:v1-0-0',
      declared: true,
      target: day(4),
      start: day(-4),
      stories: { total: 4, closed: 2 },
      points: { total: 10, closed: 8, remaining: 2 },
      days: undefined,
    },
  );
  assert.deepEqual(v1.days, [
    { day: day(-4), remaining: 10, ideal: 10 },
    { day: day(-3), remaining: 10, ideal: 8.75 },
    { day: day(-2), remaining: 7, ideal: 7.5 },
    { day: day(-1), remaining: 7, ideal: 6.25 },
    { day: day(0), remaining: 2, ideal: 5 },
    { day: day(1), remaining: null, ideal: 3.75 },
    { day: day(2), remaining: null, ideal: 2.5 },
    { day: day(3), remaining: null, ideal: 1.25 },
    { day: day(4), remaining: null, ideal: 0 },
  ]);

  // v2-0-0 only had Both: declared but empty.
  assert.deepEqual(v2, {
    version: 'v2-0-0',
    tag: 'release:v2-0-0',
    declared: true,
    target: day(30),
    start: null,
    stories: { total: 0, closed: 0 },
    points: { total: 0, closed: 0, remaining: 0 },
    days: [],
  });

  // An undeclared tag is still drawn, up to today, without an ideal line.
  assert.deepEqual(typo, {
    version: 'v1-0',
    tag: 'release:v1-0',
    declared: false,
    target: null,
    start: day(-1),
    stories: { total: 2, closed: 1 },
    points: { total: 5, closed: 1, remaining: 4 },
    days: range(-1, 0).map((d) => ({ day: d, remaining: 4, ideal: null })),
  });

  assert.deepEqual(multiTagged, [{ id: both.id, ref: both.ref, subject: 'Both', releases: ['v1-0-0', 'v2-0-0'] }]);
  // Without backlog.yaml there is a backlog-missing warning too (businessAnalyst).
  const releaseWarnings = report.warnings.filter(({ code }) => code.startsWith('release-'));
  assert.deepEqual(
    releaseWarnings.map(({ code }) => code),
    ['release-undeclared', 'release-empty', 'release-multiple'],
  );
  const [undeclared, empty, multiple] = releaseWarnings.map(({ message }) => message) as [string, string, string];
  assert.match(undeclared, /release:v1-0/);
  assert.match(empty, /v2-0-0/);
  assert.match(multiple, new RegExp(`#${both.ref}`));
  assert.deepEqual(writes(h.fake), []);

  const text = await h.taigent(['metrics', '--project', 'vigo-alpha'], { env: { TZ } });
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Release v1-0-0: 2 of 10 points left \(2 of 4 stories open\), target /);
  assert.match(text.stdout, /release-multiple/);
});

test('metrics without project.yaml has no declared release, and an invalid project.yaml fails like validate', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'vigo-alpha', name: 'Alpha', members: [h.fake.user.id] });
  addStory(h.fake, alpha.id, 'Login', { tags: ['release:v1-0-0'], created: -1, points: 3 });

  const missing = await h.taigent(['metrics', '--project', 'vigo-alpha', '--json'], { env: { TZ } });

  assert.equal(missing.code, 0, missing.stderr);
  const report = missing.json<MetricsJson>();
  assert.deepEqual(
    report.productOwner.releaseBurndown.releases.map(({ version, declared }) => [version, declared]),
    [['v1-0-0', false]],
  );
  assert.deepEqual(report.warnings.map(({ code }) => code), ['release-undeclared', 'backlog-missing']);

  await h.writeManifest('vigo-alpha', 'project.yaml', `${PROJECT_YAML}releases:\n  - version: v1-0-0\n    target: soon\n`);
  const invalid = await h.taigent(['metrics', '--project', 'vigo-alpha', '--json'], { env: { TZ } });

  assert.equal(invalid.code, 4, invalid.stderr);
  assert.deepEqual(issuesOf(invalid), [['taiga/vigo-alpha/project.yaml', 'releases[0].target', 'release-target']]);
});

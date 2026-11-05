import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { type Harness, startHarness, writes } from './support/harness.ts';

// The businessAnalyst section of `taigent metrics`: story statuses from Taiga, the rest from the backlog manifest
// and review.yaml, read through the same preview as `taigent preview`.

const TZ = 'Asia/Ho_Chi_Minh';

interface Ref {
  type: string;
  key: string;
  subject: string;
  ref: number | null;
}

interface BusinessAnalystJson {
  statuses: { stories: { status: string; closed: boolean; count: number }[]; notApplied?: number };
  acceptanceCriteria?: {
    stories: number;
    complete: number;
    rate: number | null;
    incomplete: (Ref & { epic: string; reason: string; scenarios: { scenario: string; missing: string[] }[] })[];
  };
  requirementsCoverage?: { epics: number; covered: number; rate: number | null; uncovered: Ref[] };
  awaitingReview?: (Ref & { reason: string })[];
  pendingClarification?: (Ref & { comments: { id: string; by: string; at: string; text: string }[] })[];
}

interface MetricsJson {
  businessAnalyst: BusinessAnalystJson;
  warnings: { code: string; message: string }[];
  unavailable: { metric: string; reason: string; message: string }[];
}

const MANIFEST_METRICS = [
  'businessAnalyst.statuses.notApplied',
  'businessAnalyst.acceptanceCriteria',
  'businessAnalyst.requirementsCoverage',
  'businessAnalyst.awaitingReview',
  'businessAnalyst.pendingClarification',
];

/** A story of `project` on Taiga in the status named `status`. */
function addStory(fake: FakeTaiga, project: number, subject: string, status: string): FakeUserStory {
  const found = fake.state.storyStatuses.find((candidate) => candidate.project === project && candidate.name === status)!;
  return Object.assign(fake.addUserStory({ project, subject }), { status: found.id, status_name: found.name, is_closed: found.is_closed });
}

const SCENARIO = `            - scenario: Right password
              given: [an account]
              when: I log in
              then: I see my projects
`;

const USE_CASE = `        use_case: { as_a: user, i_want_to: log in, so_that: I work }
`;

// AUTH holds a complete story, so it is covered; BILL's only story has scenarios with blank parts and DOCS has no
// story: neither is covered. AUTH-LEGACY is in the legacy format, never complete.
const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: Log in
${USE_CASE}        scenarios:
${SCENARIO}      - key: AUTH-GONE
        subject: Log out
${USE_CASE}        scenarios:
${SCENARIO}      - key: AUTH-LEGACY
        subject: Old login
        acceptance_criteria: [It works]
  - key: BILL
    subject: Billing
    stories:
      - key: BILL-PAY
        subject: Pay
${USE_CASE}        scenarios:
            - scenario: No receipt
              given: [a cart]
              when: I pay
              then: " "
            - scenario: Nothing set
              given: [" "]
              when: " "
              then: I am charged
  - key: DOCS
    subject: Documentation
issues:
  - key: BUG-CRASH
    subject: Crash on start
    type: Bug
    severity: Normal
    priority: Normal
`;

const AT = '2026-11-02T09:30:00.000Z';

async function metrics(h: Harness, slug = 'alpha'): Promise<MetricsJson> {
  const result = await h.taigent(['metrics', '--project', slug, '--json'], { env: { TZ } });
  assert.equal(result.code, 0, result.stderr);
  return result.json<MetricsJson>();
}

/** The digest `taigent preview` gives the item `key`. */
async function digestOf(h: Harness, key: string): Promise<string> {
  const result = await h.taigent(['preview', '--project', 'alpha', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const preview = result.json<{ epics: { key: string; digest: string; stories: { key: string; digest: string }[] }[] }>();
  const items = preview.epics.flatMap((epic) => [epic, ...epic.stories]);
  return items.find((item) => item.key === key)!.digest;
}

test('businessAnalyst: story statuses from Taiga, complete acceptance criteria, coverage, review and clarification', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const login = addStory(h.fake, alpha.id, 'Log in', 'Ready');
  const legacy = addStory(h.fake, alpha.id, 'Old login', 'New');
  addStory(h.fake, alpha.id, 'Made on Taiga', 'In progress');
  addStory(h.fake, alpha.id, 'Shipped', 'Done');
  await h.writeManifest('alpha', 'backlog.yaml', BACKLOG);
  // AUTH-GONE is recorded as applied but no longer on Taiga; BILL-PAY was never applied.
  const items = {
    'AUTH-LOGIN': { type: 'story', id: login.id, ref: login.ref, version: 1 },
    'AUTH-LEGACY': { type: 'story', id: legacy.id, ref: legacy.ref, version: 1 },
    'AUTH-GONE': { type: 'story', id: 99999, ref: 999, version: 1 },
  };
  await h.writeManifest('alpha', 'state.json', JSON.stringify({ project: { id: alpha.id, slug: 'alpha' }, items }));
  const review = `items:
  AUTH:
    verdict: changes
    digest: ${await digestOf(h, 'AUTH')}
    comments:
      - { id: c1, by: Lan, at: "${AT}", text: Which providers?, resolved: false }
      - { id: c2, by: Lan, at: "${AT}", text: Typo, resolved: true }
  AUTH-LOGIN:
    verdict: approved
    digest: ${await digestOf(h, 'AUTH-LOGIN')}
  AUTH-LEGACY:
    verdict: approved
    digest: not-the-current-digest
  BILL-PAY:
    comments:
      - { id: c1, by: Minh, at: "${AT}", text: Currency?, resolved: true }
`;
  await h.writeManifest('alpha', 'review.yaml', review);

  const report = await metrics(h);

  const ba = report.businessAnalyst;
  assert.deepEqual(ba.statuses, {
    stories: [
      { status: 'New', closed: false, count: 1 },
      { status: 'Ready', closed: false, count: 1 },
      { status: 'In progress', closed: false, count: 1 },
      { status: 'Ready for test', closed: false, count: 0 },
      { status: 'Done', closed: true, count: 1 },
      { status: 'Archived', closed: true, count: 0 },
    ],
    notApplied: 2,
  });
  assert.deepEqual(ba.acceptanceCriteria, {
    stories: 4,
    complete: 2,
    rate: 0.5,
    incomplete: [
      { type: 'story', key: 'AUTH-LEGACY', subject: 'Old login', ref: legacy.ref, epic: 'AUTH', reason: 'legacy', scenarios: [] },
      {
        type: 'story', key: 'BILL-PAY', subject: 'Pay', ref: null, epic: 'BILL', reason: 'incomplete-scenarios',
        scenarios: [{ scenario: 'No receipt', missing: ['then'] }, { scenario: 'Nothing set', missing: ['given', 'when'] }],
      },
    ],
  });
  assert.deepEqual(ba.requirementsCoverage, {
    epics: 3,
    covered: 1,
    rate: 0.333,
    uncovered: [
      { type: 'epic', key: 'BILL', subject: 'Billing', ref: null },
      { type: 'epic', key: 'DOCS', subject: 'Documentation', ref: null },
    ],
  });
  // No verdict, or a verdict given on another digest (stale); a verdict of changes is a verdict.
  assert.deepEqual(ba.awaitingReview, [
    { type: 'story', key: 'AUTH-GONE', subject: 'Log out', ref: 999, reason: 'unreviewed' },
    { type: 'story', key: 'AUTH-LEGACY', subject: 'Old login', ref: legacy.ref, reason: 'stale' },
    { type: 'epic', key: 'BILL', subject: 'Billing', ref: null, reason: 'unreviewed' },
    { type: 'story', key: 'BILL-PAY', subject: 'Pay', ref: null, reason: 'unreviewed' },
    { type: 'epic', key: 'DOCS', subject: 'Documentation', ref: null, reason: 'unreviewed' },
    { type: 'issue', key: 'BUG-CRASH', subject: 'Crash on start', ref: null, reason: 'unreviewed' },
  ]);
  // A resolved comment no longer asks for clarification.
  assert.deepEqual(ba.pendingClarification, [
    { type: 'epic', key: 'AUTH', subject: 'Authentication', ref: null, comments: [{ id: 'c1', by: 'Lan', at: AT, text: 'Which providers?' }] },
  ]);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.unavailable.filter(({ metric }) => metric.startsWith('businessAnalyst.')).map(({ metric }) => metric), []);
  assert.deepEqual(writes(h.fake), []);
});

test('businessAnalyst without a backlog manifest: story statuses and requirement changes only, the manifest metrics unavailable', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  addStory(h.fake, alpha.id, 'Log in', 'Ready');

  const report = await metrics(h);

  assert.deepEqual(Object.keys(report.businessAnalyst), ['statuses', 'requirementChange']);
  assert.deepEqual(report.businessAnalyst.statuses.stories.find(({ status }) => status === 'Ready'), { status: 'Ready', closed: false, count: 1 });
  assert.equal(report.businessAnalyst.statuses.notApplied, undefined);
  const missing = report.unavailable.filter(({ reason }) => reason === 'backlog-missing');
  assert.deepEqual(missing.map(({ metric }) => metric), MANIFEST_METRICS);
  assert.match(missing[0]!.message, /backlog\.yaml/);
  assert.deepEqual(report.warnings.map(({ code }) => code), ['backlog-missing']);
});

test('businessAnalyst with an invalid manifest: the manifest metrics unavailable with the first issue, the command succeeds', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  addStory(h.fake, alpha.id, 'Log in', 'Ready');
  await h.writeManifest('alpha', 'backlog.yaml', BACKLOG);
  await h.writeManifest('alpha', 'review.yaml', 'items:\n  AUTH:\n    verdict: maybe\n');

  const report = await metrics(h);

  assert.deepEqual(Object.keys(report.businessAnalyst), ['statuses', 'requirementChange']);
  const invalid = report.unavailable.filter(({ reason }) => reason === 'backlog-invalid');
  assert.deepEqual(invalid.map(({ metric }) => metric), MANIFEST_METRICS);
  assert.match(invalid[0]!.message, /taigent validate --project alpha/);
  assert.match(invalid[0]!.message, /review\.yaml/);
  assert.deepEqual(report.warnings.map(({ code }) => code), ['backlog-invalid']);
});

test('businessAnalyst in the text summary', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha' });
  addStory(h.fake, alpha.id, 'Old login', 'New');
  await h.writeManifest('alpha', 'backlog.yaml', BACKLOG);

  const result = await h.taigent(['metrics', '--project', 'alpha'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\nBusiness Analyst:\n {2}Stories by status: New 1, Ready 0, In progress 0, Ready for test 0, Done 0, Archived 0; not applied 4\n/);
  assert.match(result.stdout, /Complete acceptance criteria: 2 of 4 stories \(50%\)/);
  assert.match(result.stdout, / {4}AUTH-LEGACY Old login: legacy format/);
  assert.match(result.stdout, / {4}BILL-PAY Pay: "No receipt" missing Then; "Nothing set" missing Given, When/);
  assert.match(result.stdout, /Requirements coverage: 1 of 3 epics \(33%\)/);
  assert.match(result.stdout, / {4}DOCS Documentation/);
  assert.match(result.stdout, /Awaiting review \(8\):/);
  assert.match(result.stdout, /Pending clarification \(0\)/);
});

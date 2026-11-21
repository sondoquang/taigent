import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type BacklogItem, readBacklogFile, saveItem, type SaveResult } from '../src/backlog-write.ts';
import type { Plan } from '../src/planner.ts';
import { buildPreview, REVIEW_FILE, saveReview, setVerdict } from '../src/review.ts';
import { OFFLINE, startHarness } from './support/harness.ts';
import { LEGACY, seedLegacy } from './support/legacy-story.ts';

const BACKLOG = `# Backlog of the demo project.
epics:
  - key: AUTH # the login epic
    subject: Authentication
    tags: [type:feature]
    stories:
      # Already on Taiga.
      - key: AUTH-LOGIN
        subject: "Log in with email"
        use_case:
          as_a: registered user
          i_want_to: log in with my email
          so_that: I see my own data
        scenarios:
          - scenario: Wrong password
            given: [a registered user]
            when: they type a wrong password
            then: an error shows
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            description: "Done when: POST /login returns a token."
          - key: AUTH-LOGIN-UI # form only
            subject: Login form
  - key: BILLING
    subject: Billing
    tags: [type:feature]
    stories:
      - key: BILLING-PAY
        subject: Pay by card
        acceptance_criteria:
          - A declined card shows why
`;

/** AUTH, AUTH-LOGIN and AUTH-LOGIN-API are on Taiga. */
const STATE = JSON.stringify({
  project: { id: 7, slug: 'demo' },
  items: {
    AUTH: { type: 'epic', id: 1, ref: 1, version: 1 },
    'AUTH-LOGIN': { type: 'story', id: 2, ref: 2, version: 1 },
    'AUTH-LOGIN-API': { type: 'task', id: 3, ref: 3, version: 1 },
  },
});

const AT = '2026-11-02T09:30:00.000Z';

async function project(t: TestContext, backlog = BACKLOG): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taigent-backlog-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'backlog.yaml'), backlog);
  await writeFile(join(dir, 'state.json'), STATE);
  return dir;
}

const backlogText = (dir: string) => readFile(join(dir, 'backlog.yaml'), 'utf8');

async function digest(dir: string): Promise<string> {
  return (await readBacklogFile(dir)).digest;
}

function saved<T extends object>(result: SaveResult<T>) {
  if (result.status !== 'saved') assert.fail(`expected saved, got ${JSON.stringify(result)}`);
  return result;
}

function issuesOf(result: SaveResult<object>): { path: string; rule: string }[] {
  if (result.status !== 'invalid') assert.fail(`expected invalid, got ${JSON.stringify(result)}`);
  return result.issues.map(({ path, rule }) => ({ path, rule }));
}

test('readBacklogFile returns the file and the SHA-256 of its bytes', async (t) => {
  const dir = await project(t);
  const file = await readBacklogFile(dir);
  assert.equal(file.text, BACKLOG);
  assert.equal(file.digest, createHash('sha256').update(BACKLOG).digest('hex'));
  assert.equal(file.file, join(dir, 'backlog.yaml'));
});

test('saveItem adds an epic and a task, keeping comments, order and the style of untouched nodes', async (t) => {
  const dir = await project(t);
  const epic = saved(
    await saveItem(dir, {
      baseDigest: await digest(dir),
      item: {
        type: 'epic',
        key: 'SEARCH',
        fields: { subject: 'Search', description: 'Find anything.\nFast.', tags: ['type:feature', 'area:search'], customAttributes: { Owner: 'Lan' } },
      },
    }),
  );
  assert.equal(epic.path, 'epics[2]');
  const task = saved(
    await saveItem(dir, {
      baseDigest: epic.digest,
      item: { type: 'task', key: 'AUTH-LOGIN-DOCS', parent: 'AUTH-LOGIN', fields: { subject: 'Document the endpoint', description: 'Done when: the API page lists /login.' } },
    }),
  );
  assert.equal(task.path, 'epics[0].stories[0].tasks[2]');
  assert.equal(task.digest, await digest(dir));
  assert.equal(
    await backlogText(dir),
    BACKLOG.replace(
      '            subject: Login form\n',
      '            subject: Login form\n          - key: AUTH-LOGIN-DOCS\n            subject: Document the endpoint\n            description: "Done when: the API page lists /login."\n',
    ) +
      `  - key: SEARCH
    subject: Search
    description: |-
      Find anything.
      Fast.
    tags:
      - type:feature
      - area:search
    custom_attributes:
      Owner: Lan
`,
  );
});

test('the first epic of a project without backlog.yaml creates the file', async (t) => {
  const dir = await project(t);
  await rm(join(dir, 'backlog.yaml'));
  const empty = await readBacklogFile(dir);
  assert.equal(empty.text, '');
  saved(await saveItem(dir, { baseDigest: empty.digest, item: { type: 'epic', key: 'AUTH', fields: { subject: 'Authentication' } } }));
  assert.equal(await backlogText(dir), 'epics:\n  - key: AUTH\n    subject: Authentication\n');
});

test('saveItem edits fields in place: other nodes keep their style, an empty field is removed, CRLF stays', async (t) => {
  const dir = await project(t, BACKLOG.replace(/\n/g, '\r\n'));
  const edited = saved(
    await saveItem(dir, {
      baseDigest: await digest(dir),
      edit: true,
      item: { type: 'epic', key: 'AUTH', fields: { subject: 'Authentication and sessions', description: 'Who may do what.', tags: ['type:feature', 'area:auth'] } },
    }),
  );
  assert.equal(edited.path, 'epics[0]');
  saved(
    await saveItem(dir, {
      baseDigest: edited.digest,
      edit: true,
      item: { type: 'task', key: 'AUTH-LOGIN-API', parent: 'AUTH-LOGIN', fields: { description: '' } },
    }),
  );
  const expected = BACKLOG.replace(
    '    subject: Authentication\n    tags: [type:feature]\n',
    '    subject: Authentication and sessions\n    description: Who may do what.\n    tags: [type:feature, area:auth]\n',
  ).replace('            description: "Done when: POST /login returns a token."\n', '');
  assert.equal(await backlogText(dir), expected.replace(/\n/g, '\r\n'));
});

test('a saved item is unreviewed when new, and an edit of an approved item turns its verdict stale', async (t) => {
  const dir = await project(t);
  const before = await buildPreview(dir, 'demo');
  const api = before.epics[0]!.stories[0]!.tasks[0]!;
  await saveReview(join(dir, REVIEW_FILE), setVerdict({ items: {} }, api.key, 'approved', api.digest, 'Lan', AT));
  const review = await readFile(join(dir, REVIEW_FILE), 'utf8');

  const edited = saved(
    await saveItem(dir, {
      baseDigest: await digest(dir),
      edit: true,
      item: { type: 'task', key: 'AUTH-LOGIN-API', parent: 'AUTH-LOGIN', fields: { subject: 'Login endpoint with rate limit' } },
    }),
  );
  saved(await saveItem(dir, { baseDigest: edited.digest, item: { type: 'epic', key: 'SEARCH', fields: { subject: 'Search' } } }));

  assert.equal(await backlogText(dir), `${BACKLOG.replace('subject: Login endpoint', 'subject: Login endpoint with rate limit')}  - key: SEARCH\n    subject: Search\n`);
  const after = await buildPreview(dir, 'demo');
  assert.deepEqual(
    { verdict: after.epics[0]!.stories[0]!.tasks[0]!.review.verdict, stale: after.epics[0]!.stories[0]!.tasks[0]!.review.stale },
    { verdict: 'approved', stale: true },
  );
  assert.deepEqual(after.epics[2]!.review, { stale: false, comments: [], openComments: 0 });
  assert.equal(await readFile(join(dir, REVIEW_FILE), 'utf8'), review, 'review.yaml is never touched');
});

test('saveItem moves a task to another story and a story with its tasks to another epic, comments included', async (t) => {
  const dir = await project(t);
  const task = saved(
    await saveItem(dir, {
      baseDigest: await digest(dir),
      edit: true,
      item: { type: 'task', key: 'AUTH-LOGIN-UI', parent: 'BILLING-PAY', fields: {} },
    }),
  );
  assert.equal(task.path, 'epics[1].stories[0].tasks[0]');
  const story = saved(
    await saveItem(dir, {
      baseDigest: task.digest,
      edit: true,
      item: { type: 'story', key: 'AUTH-LOGIN', parent: 'BILLING', fields: {} },
    }),
  );
  assert.equal(story.path, 'epics[1].stories[1]');

  const text = await backlogText(dir);
  assert.match(text, /- key: AUTH-LOGIN-UI # form only\n/);
  assert.ok(text.indexOf('# Already on Taiga.') > text.indexOf('- key: BILLING-PAY'), 'the comment moves with its story');
  assert.ok(!/key: AUTH\n[\s\S]*stories:[\s\S]*key: BILLING\n/.test(text), 'AUTH has no stories list left');
  const preview = await buildPreview(dir, 'demo');
  assert.deepEqual(preview.epics[0]!.stories, []);
  const [pay, login] = preview.epics[1]!.stories;
  assert.deepEqual(pay!.tasks.map((item) => [item.key, item.parent]), [['AUTH-LOGIN-UI', 'BILLING-PAY']]);
  assert.deepEqual([login!.key, login!.parent, login!.tasks.map((item) => item.key)], ['AUTH-LOGIN', 'BILLING', ['AUTH-LOGIN-API']]);
});

test('a write on a stale baseDigest is a conflict: nothing is written, the current file comes back, re-applying works', async (t) => {
  const dir = await project(t);
  const base = await digest(dir);
  const byAgent = BACKLOG.replace('subject: Billing', 'subject: Billing and invoices');
  await writeFile(join(dir, 'backlog.yaml'), byAgent);

  const item = { type: 'epic', key: 'SEARCH', fields: { subject: 'Search' } } as const;
  const conflict = await saveItem(dir, { baseDigest: base, item });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.status === 'conflict' && conflict.current, { file: join(dir, 'backlog.yaml'), text: byAgent, digest: createHash('sha256').update(byAgent).digest('hex') });
  assert.equal(await backlogText(dir), byAgent);

  saved(await saveItem(dir, { baseDigest: conflict.status === 'conflict' ? conflict.current.digest : '', item }));
  assert.equal(await backlogText(dir), `${byAgent}  - key: SEARCH\n    subject: Search\n`);
});

test('only issues under the written item block a save, with their path and rule; issues elsewhere do not', async (t) => {
  const dir = await project(t, BACKLOG.replace('subject: Billing\n    tags: [type:feature]', 'subject: Billing\n    tags: [feature]'));
  const base = await digest(dir);
  const edited = saved(await saveItem(dir, { baseDigest: base, edit: true, item: { type: 'epic', key: 'AUTH', fields: { subject: 'Auth' } } }));
  const text = await backlogText(dir);

  const attempts: [BacklogItem, { path: string; rule: string }[]][] = [
    [{ type: 'task', key: 'AUTH-LOGIN-DOCS', parent: 'AUTH-LOGIN', fields: { subject: ' ', tags: ['urgent'] } }, [
      { path: 'epics[0].stories[0].tasks[2].subject', rule: 'required' },
      { path: 'epics[0].stories[0].tasks[2].tags[0]', rule: 'tag-prefix' },
    ]],
    [{ type: 'epic', key: 'AUTH-LOGIN', fields: { subject: 'Twice' } }, [{ path: 'epics[2].key', rule: 'key-unique' }]],
    [{ type: 'epic', key: 'auth search', fields: { subject: 'Lowercase' } }, [{ path: 'epics[2].key', rule: 'key-format' }]],
    [{ type: 'task', key: 'NOPE-TASK', parent: 'NOPE', fields: { subject: 'Orphan' } }, [{ path: '', rule: 'key-reference' }]],
  ];
  for (const [item, issues] of attempts) {
    assert.deepEqual(issuesOf(await saveItem(dir, { baseDigest: edited.digest, item })), issues, item.key);
  }
  // An edit names an item of its type: BILLING-PAY is a story, not a task.
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: edited.digest, edit: true, item: { type: 'task', key: 'BILLING-PAY', parent: 'AUTH-LOGIN', fields: {} } })),
    [{ path: '', rule: 'key-reference' }],
  );
  assert.equal(await backlogText(dir), text, 'nothing is written');
});

test('issues share the key space; epics are added before the issues list', async (t) => {
  const issues = 'issues:\n  - key: LOGIN-SLOW\n    subject: Login times out on slow networks\n    type: Bug\n    severity: Normal\n    priority: Normal\n';
  const dir = await project(t, BACKLOG + issues);
  const epic = saved(await saveItem(dir, { baseDigest: await digest(dir), item: { type: 'epic', key: 'SEARCH', fields: { subject: 'Search' } } }));
  assert.equal(await backlogText(dir), `${BACKLOG}  - key: SEARCH\n    subject: Search\n${issues}`);
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: epic.digest, item: { type: 'task', key: 'LOGIN-SLOW', parent: 'AUTH-LOGIN', fields: { subject: 'Twice' } } })),
    [{ path: 'epics[0].stories[0].tasks[2].key', rule: 'key-unique' }],
  );
});

test('saveItem adds and edits an issue', async (t) => {
  const dir = await project(t);
  const issue: BacklogItem = {
    type: 'issue',
    key: 'LOGIN-500',
    fields: { subject: 'Login fails with a long password', description: '## Steps to reproduce\n\n1. Sign in\n', type: 'Bug', severity: 'Normal', priority: 'High', tags: ['area:auth'] },
  };
  const added = saved(await saveItem(dir, { baseDigest: await digest(dir), item: issue }));
  assert.equal(added.path, 'issues[0]');
  assert.equal(
    await backlogText(dir),
    `${BACKLOG}issues:\n  - key: LOGIN-500\n    subject: Login fails with a long password\n    description: |\n      ## Steps to reproduce\n\n      1. Sign in\n    type: Bug\n    severity: Normal\n    priority: High\n    tags:\n      - area:auth\n`,
  );

  const edited = saved(await saveItem(dir, { baseDigest: added.digest, edit: true, item: { type: 'issue', key: 'LOGIN-500', fields: { priority: 'Low', tags: [] } } }));
  assert.match(await backlogText(dir), /    severity: Normal\n    priority: Low\n$/);
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: edited.digest, edit: true, item: { type: 'issue', key: 'LOGIN-500', fields: { subject: '', severity: '' } } })),
    [{ path: 'issues[0].subject', rule: 'required' }, { path: 'issues[0].severity', rule: 'required' }],
  );
});

test('saveItem adds a user story format story with its scenarios; a broken use case or scenario is reported on its field', async (t) => {
  const dir = await project(t);
  const base = await digest(dir);
  const story: BacklogItem = {
    type: 'story',
    key: 'BILLING-REFUND',
    parent: 'BILLING',
    fields: {
      subject: 'Refund a payment',
      useCase: { asA: 'shop owner', iWantTo: 'refund a card payment', soThat: 'the customer gets the money back' },
      scenarios: [
        { scenario: 'Full refund', given: ['a paid order', 'the payment is settled'], when: 'I refund the full amount', then: 'the customer sees the refund' },
        { scenario: 'Refund twice', given: ['a refunded order'], when: 'I refund it again', then: 'I see that it is already refunded' },
      ],
      description: 'Card payments only.',
      spec: 'docs/specs/billing.md',
      tags: ['type:feature'],
    },
  };
  const broken = { ...story.fields, useCase: { asA: '', iWantTo: 'refund', soThat: 'money back' }, scenarios: [{ scenario: 'Full refund', given: [], when: '', then: 'refunded' }] };
  assert.deepEqual(issuesOf(await saveItem(dir, { baseDigest: base, item: { ...story, fields: broken } })), [
    { path: 'epics[1].stories[1].use_case.as_a', rule: 'required' },
    { path: 'epics[1].stories[1].scenarios[0].given', rule: 'required' },
    { path: 'epics[1].stories[1].scenarios[0].when', rule: 'required' },
  ]);
  assert.equal(await backlogText(dir), BACKLOG, 'nothing is written');

  assert.equal(saved(await saveItem(dir, { baseDigest: base, item: story })).path, 'epics[1].stories[1]');
  assert.equal(
    await backlogText(dir),
    `${BACKLOG}      - key: BILLING-REFUND
        subject: Refund a payment
        use_case:
          as_a: shop owner
          i_want_to: refund a card payment
          so_that: the customer gets the money back
        scenarios:
          - scenario: Full refund
            given:
              - a paid order
              - the payment is settled
            when: I refund the full amount
            then: the customer sees the refund
          - scenario: Refund twice
            given:
              - a refunded order
            when: I refund it again
            then: I see that it is already refunded
        description: Card payments only.
        spec: docs/specs/billing.md
        tags:
          - type:feature
`,
  );
  const added = (await buildPreview(dir, 'demo')).epics[1]!.stories[1]!;
  assert.deepEqual([added.format, added.review.verdict], ['user-story', undefined]);
  assert.equal(
    added.description,
    [
      '- **As a** shop owner',
      '- **I want to** refund a card payment',
      '- **so that** the customer gets the money back',
      '',
      'Card payments only.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] **Scenario:** Full refund',
      '  - **Given:** a paid order',
      '  - **and Given:** the payment is settled',
      '  - **When:** I refund the full amount',
      '  - **Then:** the customer sees the refund',
      '- [ ] **Scenario:** Refund twice',
      '  - **Given:** a refunded order',
      '  - **When:** I refund it again',
      '  - **Then:** I see that it is already refunded',
      '',
      'Spec: docs/specs/billing.md',
    ].join('\n'),
  );
});

test('editing a legacy story keeps its format; giving it a use case and scenarios converts it and updates the description', async (t) => {
  const h = await startHarness(t);
  seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY);
  // Records the baseline, so the edits below are the manifest's changes, not remote edits.
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  const dir = join(h.manifestsDir, 'demo');
  const updates = async () => {
    const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
    assert.equal(plan.code, 3, plan.stderr);
    return plan.json<Plan>().operations.flatMap((op) => (op.action === 'update' ? [[op.key, Object.keys(op.changes)]] : []));
  };

  const story = { type: 'story', key: 'AUTH-LOGIN', parent: 'AUTH' } as const;
  const edited = saved(await saveItem(dir, { baseDigest: await digest(dir), edit: true, item: { ...story, fields: { subject: 'User can sign in' } } }));
  assert.equal(await backlogText(dir), LEGACY.replace('subject: User can log in', 'subject: User can sign in'));
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['subject']]]);

  // Converting to the user story format: a use case and scenarios replace acceptance_criteria.
  saved(
    await saveItem(dir, {
      baseDigest: edited.digest,
      edit: true,
      item: {
        ...story,
        fields: {
          useCase: { asA: 'user', iWantTo: 'log in', soThat: 'I see my projects' },
          scenarios: [{ scenario: 'Wrong password', given: ['I am on the sign-in page'], when: 'I submit a wrong password', then: 'I see an error' }],
        },
      },
    }),
  );
  assert.doesNotMatch(await backlogText(dir), /acceptance_criteria/);
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['subject', 'description']]], 'the subject edit is still unapplied');
  assert.equal((await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE })).code, 0);
});

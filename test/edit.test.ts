import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { type BacklogItem, type EditResult, readItem, readManifestFile, readWikiPages, removeItem, saveItem, saveWikiPage } from '../src/edit.ts';
import { issueKeyPrefix, suggestKey } from '../src/manifest/conventions.ts';
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
  const dir = await mkdtemp(join(tmpdir(), 'taigent-edit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'backlog.yaml'), backlog);
  await writeFile(join(dir, 'state.json'), STATE);
  return dir;
}

const backlogText = (dir: string) => readFile(join(dir, 'backlog.yaml'), 'utf8');

async function digest(dir: string): Promise<string> {
  return (await readManifestFile(dir, 'backlog')).digest;
}

function saved<T extends object>(result: EditResult<T>) {
  if (result.status !== 'saved') assert.fail(`expected saved, got ${JSON.stringify(result)}`);
  return result;
}

function issuesOf(result: EditResult<object>): { path: string; rule: string }[] {
  if (result.status !== 'invalid') assert.fail(`expected invalid, got ${JSON.stringify(result)}`);
  return result.issues.map(({ path, rule }) => ({ path, rule }));
}

test('readManifestFile returns the file and the SHA-256 of its bytes', async (t) => {
  const dir = await project(t);
  const file = await readManifestFile(dir, 'backlog');
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
  const empty = await readManifestFile(dir, 'backlog');
  assert.equal(empty.text, '');
  saved(await saveItem(dir, { baseDigest: empty.digest, item: { type: 'epic', key: 'AUTH', fields: { subject: 'Authentication' } } }));
  assert.equal(await backlogText(dir), 'epics:\n  - key: AUTH\n    subject: Authentication\n');
});

test('saveItem edits fields in place: other nodes keep their style, an empty field is removed, CRLF stays', async (t) => {
  const dir = await project(t, BACKLOG.replace(/\n/g, '\r\n'));
  const edited = saved(
    await saveItem(dir, {
      baseDigest: await digest(dir),
      original: 'AUTH',
      item: { type: 'epic', key: 'AUTH', fields: { subject: 'Authentication and sessions', description: 'Who may do what.', tags: ['type:feature', 'area:auth'] } },
    }),
  );
  assert.equal(edited.path, 'epics[0]');
  saved(
    await saveItem(dir, {
      baseDigest: edited.digest,
      original: 'AUTH-LOGIN-API',
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
      original: 'AUTH-LOGIN-API',
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
      original: 'AUTH-LOGIN-UI',
      item: { type: 'task', key: 'AUTH-LOGIN-UI', parent: 'BILLING-PAY', fields: {} },
    }),
  );
  assert.equal(task.path, 'epics[1].stories[0].tasks[0]');
  const story = saved(
    await saveItem(dir, {
      baseDigest: task.digest,
      original: 'AUTH-LOGIN',
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

test('removeItem deletes a story with its tasks and names the removed keys already on Taiga as orphaned', async (t) => {
  const dir = await project(t);
  const removed = saved(await removeItem(dir, { baseDigest: await digest(dir), type: 'story', key: 'AUTH-LOGIN' }));
  assert.deepEqual(removed.removed, ['AUTH-LOGIN', 'AUTH-LOGIN-API', 'AUTH-LOGIN-UI']);
  assert.deepEqual(removed.orphaned, ['AUTH-LOGIN', 'AUTH-LOGIN-API']);
  const text = await backlogText(dir);
  const auth = text.slice(0, text.indexOf('  - key: BILLING'));
  assert.equal(auth, '# Backlog of the demo project.\nepics:\n  - key: AUTH # the login epic\n    subject: Authentication\n    tags: [type:feature]\n');
  assert.equal(text.slice(auth.length), BACKLOG.slice(BACKLOG.indexOf('  - key: BILLING')));

  // An item is found by type and key: BILLING-PAY is a story, not a task.
  assert.deepEqual(issuesOf(await removeItem(dir, { baseDigest: removed.digest, type: 'task', key: 'BILLING-PAY' })), [{ path: '', rule: 'key-reference' }]);
  const story = saved(await removeItem(dir, { baseDigest: removed.digest, type: 'story', key: 'BILLING-PAY' }));
  assert.deepEqual([story.removed, story.orphaned], [['BILLING-PAY'], []]);
  assert.ok(!(await backlogText(dir)).includes('stories:'), 'an emptied stories list is removed');
});

test('removeItem deletes an epic with its stories and tasks; those already on Taiga are orphaned', async (t) => {
  const dir = await project(t);
  const epic = saved(await removeItem(dir, { baseDigest: await digest(dir), type: 'epic', key: 'AUTH' }));
  assert.deepEqual(epic.removed, ['AUTH', 'AUTH-LOGIN', 'AUTH-LOGIN-API', 'AUTH-LOGIN-UI']);
  assert.deepEqual(epic.orphaned, ['AUTH', 'AUTH-LOGIN', 'AUTH-LOGIN-API']);
  assert.equal(await backlogText(dir), `# Backlog of the demo project.\nepics:\n${BACKLOG.slice(BACKLOG.indexOf('  - key: BILLING'))}`);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), STATE, 'state.json is left to apply');
  assert.equal(epic.digest, await digest(dir));
});

test('removeItem deletes a task alone; removing the last task removes the tasks list', async (t) => {
  const dir = await project(t);
  const form = saved(await removeItem(dir, { baseDigest: await digest(dir), type: 'task', key: 'AUTH-LOGIN-UI' }));
  assert.deepEqual([form.removed, form.orphaned], [['AUTH-LOGIN-UI'], []]);
  assert.equal(await backlogText(dir), BACKLOG.replace('          - key: AUTH-LOGIN-UI # form only\n            subject: Login form\n', ''));

  const api = saved(await removeItem(dir, { baseDigest: form.digest, type: 'task', key: 'AUTH-LOGIN-API' }));
  assert.deepEqual([api.removed, api.orphaned], [['AUTH-LOGIN-API'], ['AUTH-LOGIN-API']]);
  const text = await backlogText(dir);
  assert.ok(!text.includes('tasks:'), 'an emptied tasks list is removed');
  assert.equal(text, BACKLOG.slice(0, BACKLOG.indexOf('        tasks:')) + BACKLOG.slice(BACKLOG.indexOf('  - key: BILLING')));
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
  assert.equal((await removeItem(dir, { baseDigest: base, type: 'epic', key: 'BILLING' })).status, 'conflict');
  assert.equal(await backlogText(dir), byAgent);

  saved(await saveItem(dir, { baseDigest: conflict.status === 'conflict' ? conflict.current.digest : '', item }));
  assert.equal(await backlogText(dir), `${byAgent}  - key: SEARCH\n    subject: Search\n`);
});

test('only issues under the edited item block a save, with their path and rule; issues elsewhere do not', async (t) => {
  const dir = await project(t, BACKLOG.replace('subject: Billing\n    tags: [type:feature]', 'subject: Billing\n    tags: [feature]'));
  const base = await digest(dir);
  const edited = saved(await saveItem(dir, { baseDigest: base, original: 'AUTH', item: { type: 'epic', key: 'AUTH', fields: { subject: 'Auth' } } }));
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
  // Renaming an item to a key used further down reports it on the edited item, not only on the later one.
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: edited.digest, original: 'AUTH-LOGIN-UI', item: { type: 'task', key: 'BILLING-PAY', parent: 'AUTH-LOGIN', fields: {} } })),
    [{ path: 'epics[0].stories[0].tasks[1].key', rule: 'key-unique' }],
  );
  assert.equal(await backlogText(dir), text, 'nothing is written');
});

test('the key of an item already on Taiga is locked; a new item can be re-keyed', async (t) => {
  const dir = await project(t);
  const base = await digest(dir);
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: base, original: 'AUTH-LOGIN-API', item: { type: 'task', key: 'AUTH-LOGIN-TOKEN', parent: 'AUTH-LOGIN', fields: {} } })),
    [{ path: 'epics[0].stories[0].tasks[0].key', rule: 'key-locked' }],
  );
  saved(await saveItem(dir, { baseDigest: base, original: 'BILLING', item: { type: 'epic', key: 'PAYMENTS', fields: {} } }));
  assert.match(await backlogText(dir), /\n {2}- key: PAYMENTS\n {4}subject: Billing\n/);
});

test('issues share the key space and can be removed; epics are added before the issues list', async (t) => {
  const issues = 'issues:\n  - key: LOGIN-SLOW\n    subject: Login times out on slow networks\n    type: Bug\n    severity: Normal\n    priority: Normal\n';
  const dir = await project(t, BACKLOG + issues);
  const epic = saved(await saveItem(dir, { baseDigest: await digest(dir), item: { type: 'epic', key: 'SEARCH', fields: { subject: 'Search' } } }));
  assert.equal(await backlogText(dir), `${BACKLOG}  - key: SEARCH\n    subject: Search\n${issues}`);
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: epic.digest, item: { type: 'task', key: 'LOGIN-SLOW', parent: 'AUTH-LOGIN', fields: { subject: 'Twice' } } })),
    [{ path: 'epics[0].stories[0].tasks[2].key', rule: 'key-unique' }],
  );
  const removed = saved(await removeItem(dir, { baseDigest: epic.digest, type: 'issue', key: 'LOGIN-SLOW' }));
  assert.deepEqual([removed.removed, removed.orphaned], [['LOGIN-SLOW'], []]);
  assert.equal(await backlogText(dir), `${BACKLOG}  - key: SEARCH\n    subject: Search\n`);
});

test('saveItem adds, edits and removes an issue; readItem returns it as its form edits it', async (t) => {
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
  const text = await backlogText(dir);
  assert.deepEqual(readItem(text, 'issue', 'LOGIN-500'), { ...issue, fields: { ...issue.fields, customAttributes: {} } });

  const edited = saved(await saveItem(dir, { baseDigest: added.digest, original: 'LOGIN-500', item: { type: 'issue', key: 'LOGIN-500', fields: { priority: 'Low', tags: [] } } }));
  assert.match(await backlogText(dir), /    severity: Normal\n    priority: Low\n$/);
  assert.deepEqual(
    issuesOf(await saveItem(dir, { baseDigest: edited.digest, original: 'LOGIN-500', item: { type: 'issue', key: 'LOGIN-500', fields: { subject: '', severity: '' } } })),
    [{ path: 'issues[0].subject', rule: 'required' }, { path: 'issues[0].severity', rule: 'required' }],
  );
  const removed = saved(await removeItem(dir, { baseDigest: edited.digest, type: 'issue', key: 'LOGIN-500' }));
  assert.deepEqual(removed.removed, ['LOGIN-500']);
  assert.equal(await backlogText(dir), BACKLOG);
});

test('readItem returns a story as its form edits it, in its own format; saving it back leaves the file as it was', async (t) => {
  const dir = await project(t);
  const file = await readManifestFile(dir, 'backlog');
  const common = { description: '', spec: '', tags: [], customAttributes: {} };
  assert.deepEqual(readItem(file.text, 'story', 'AUTH-LOGIN'), {
    type: 'story',
    key: 'AUTH-LOGIN',
    parent: 'AUTH',
    fields: {
      subject: 'Log in with email',
      ...common,
      useCase: { asA: 'registered user', iWantTo: 'log in with my email', soThat: 'I see my own data' },
      scenarios: [{ scenario: 'Wrong password', given: ['a registered user'], when: 'they type a wrong password', then: 'an error shows' }],
    },
  });
  assert.deepEqual(readItem(file.text, 'story', 'BILLING-PAY'), {
    type: 'story',
    key: 'BILLING-PAY',
    parent: 'BILLING',
    fields: { subject: 'Pay by card', ...common, acceptanceCriteria: ['A declined card shows why'] },
  });
  assert.deepEqual(readItem(file.text, 'task', 'AUTH-LOGIN-API'), {
    type: 'task',
    key: 'AUTH-LOGIN-API',
    parent: 'AUTH-LOGIN',
    fields: { subject: 'Login endpoint', description: 'Done when: POST /login returns a token.', tags: [], customAttributes: {} },
  });
  assert.equal(readItem(file.text, 'story', 'AUTH'), undefined);

  for (const key of ['AUTH-LOGIN', 'BILLING-PAY']) {
    saved(await saveItem(dir, { baseDigest: file.digest, original: key, item: readItem(file.text, 'story', key)! }));
    assert.equal(await backlogText(dir), BACKLOG, key);
  }
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

test('editing a legacy story through the story form keeps its format; converting it updates the description', async (t) => {
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

  const file = await readManifestFile(dir, 'backlog');
  const story = readItem(file.text, 'story', 'AUTH-LOGIN');
  assert.ok(story?.type === 'story');
  const edited = saved(await saveItem(dir, { baseDigest: file.digest, original: 'AUTH-LOGIN', item: { ...story, fields: { ...story.fields, subject: 'User can sign in' } } }));
  assert.equal(await backlogText(dir), LEGACY.replace('subject: User can log in', 'subject: User can sign in'));
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['subject']]]);

  // "Chuyển sang user story format": the form sends a use case and scenarios instead of acceptance_criteria.
  const { acceptanceCriteria: _criteria, ...rest } = story.fields;
  saved(
    await saveItem(dir, {
      baseDigest: edited.digest,
      original: 'AUTH-LOGIN',
      item: {
        ...story,
        fields: {
          ...rest,
          useCase: { asA: 'user', iWantTo: 'log in', soThat: 'I see my projects' },
          scenarios: [{ scenario: 'Wrong password', given: ['I am on the sign-in page'], when: 'I submit a wrong password', then: 'I see an error' }],
        },
      },
    }),
  );
  assert.doesNotMatch(await backlogText(dir), /acceptance_criteria/);
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['description']]]);
  assert.equal((await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE })).code, 0);
});

test('suggestKey follows the naming advice and skips taken keys', () => {
  assert.equal(suggestKey('Search', undefined, new Set()), 'SEARCH');
  assert.equal(suggestKey('Đăng nhập bằng Google', 'AUTH', new Set(['AUTH-DANG-NHAP'])), 'AUTH-DANG-NHAP-2');
  assert.equal(suggestKey('Login API', 'AUTH-LOGIN', new Set()), 'AUTH-LOGIN-LOGIN-API');
  assert.equal(suggestKey('!!!', undefined, new Set()), '');
});

test('an issue key starts with the prefix of its type (conventions §5): BUG-, ASK- or ENH-', () => {
  assert.equal(suggestKey('Login fails with a long password', issueKeyPrefix('Bug'), new Set()), 'BUG-LOGIN-FAILS');
  assert.equal(suggestKey('How do I reset it?', issueKeyPrefix('Question'), new Set()), 'ASK-HOW-DO');
  assert.equal(suggestKey('Dark mode', issueKeyPrefix('Enhancement'), new Set(['ENH-DARK-MODE'])), 'ENH-DARK-MODE-2');
  assert.equal(issueKeyPrefix('question'), 'ASK');
  assert.equal(issueKeyPrefix('Support request'), 'BUG', 'a type the defaults do not name is a bug');
  assert.equal(issueKeyPrefix(''), 'BUG');
});

// ---- wiki pages (docs.yaml + pages/) ------------------------------------------------------------------------------

const DOCS = `# Documents of the demo project.
wiki:
  - slug: spec-auth # the login spec
    file: pages/spec-auth.md
attachments:
  - target: wiki:spec-auth
    file: files/login-flow.pdf
`;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function docsProject(t: TestContext, docs: string | null = DOCS): Promise<string> {
  const dir = await project(t);
  await mkdir(join(dir, 'pages'));
  await mkdir(join(dir, 'files'));
  await writeFile(join(dir, 'pages', 'spec-auth.md'), '# Login\n');
  await writeFile(join(dir, 'files', 'login-flow.pdf'), 'pdf');
  if (docs !== null) await writeFile(join(dir, 'docs.yaml'), docs);
  return dir;
}

const docsText = (dir: string) => readFile(join(dir, 'docs.yaml'), 'utf8');

test('saveWikiPage adds a page under pages/ with its docs.yaml entry, keeping the other entries and comments', async (t) => {
  const dir = await docsProject(t);
  const base = await readManifestFile(dir, 'docs');
  const page = saved(await saveWikiPage(dir, { baseDigest: base.digest, page: { slug: 'adr-0001-use-rest', content: '# Use REST\n\nWe call Taiga over REST.\n' } }));
  assert.equal(page.path, 'wiki[1]');
  assert.deepEqual(page.page, { file: join(dir, 'pages', 'adr-0001-use-rest.md'), text: '# Use REST\n\nWe call Taiga over REST.\n', digest: sha('# Use REST\n\nWe call Taiga over REST.\n') });
  assert.equal(await readFile(join(dir, 'pages', 'adr-0001-use-rest.md'), 'utf8'), '# Use REST\n\nWe call Taiga over REST.\n');
  assert.equal(await docsText(dir), DOCS.replace('attachments:', '  - slug: adr-0001-use-rest\n    file: pages/adr-0001-use-rest.md\nattachments:'));
  assert.equal(page.digest, sha(await docsText(dir)));

  const wiki = await readWikiPages(dir);
  assert.equal(wiki.docs.digest, page.digest);
  assert.deepEqual(
    wiki.pages.map(({ slug, file, page: { text } }) => ({ slug, file, text })),
    [
      { slug: 'spec-auth', file: 'pages/spec-auth.md', text: '# Login\n' },
      { slug: 'adr-0001-use-rest', file: 'pages/adr-0001-use-rest.md', text: '# Use REST\n\nWe call Taiga over REST.\n' },
    ],
  );
});

test('saveWikiPage edits the file an entry names, wherever it is, keeping CRLF; docs.yaml stays as it is', async (t) => {
  // A folder next to the project's, unique to this run: two test runs at once must not share the file.
  const dir = await docsProject(t);
  const shared = `${basename(dir)}-shared`;
  const docs = DOCS.replace('attachments:', `  - slug: spec-billing\n    file: ../${shared}/billing.md\nattachments:`);
  await writeFile(join(dir, 'docs.yaml'), docs);
  await mkdir(join(dir, '..', shared), { recursive: true });
  const billing = join(dir, '..', shared, 'billing.md');
  t.after(() => rm(join(dir, '..', shared), { recursive: true, force: true }));
  await writeFile(billing, '# Billing\r\n\r\nOld.\r\n');
  const wiki = await readWikiPages(dir);
  const opened = wiki.pages.find((page) => page.slug === 'spec-billing')!;
  assert.equal(opened.page.text, '# Billing\r\n\r\nOld.\r\n');

  const edited = saved(await saveWikiPage(dir, { baseDigest: wiki.docs.digest, pageDigest: opened.page.digest, page: { slug: 'spec-billing', content: '# Billing\n\nNew.\n' } }));
  assert.equal(edited.path, 'wiki[1]');
  assert.equal(edited.digest, wiki.docs.digest);
  assert.equal(await readFile(billing, 'utf8'), '# Billing\r\n\r\nNew.\r\n');
  assert.equal(edited.page.digest, sha('# Billing\r\n\r\nNew.\r\n'));
  assert.equal(await docsText(dir), docs);
});

test('a wiki save on a stale docs.yaml or page digest is a conflict and writes nothing', async (t) => {
  const dir = await docsProject(t);
  const wiki = await readWikiPages(dir);
  const spec = wiki.pages[0]!;
  await writeFile(join(dir, 'pages', 'spec-auth.md'), '# Login (agent)\n');
  const pageConflict = await saveWikiPage(dir, { baseDigest: wiki.docs.digest, pageDigest: spec.page.digest, page: { slug: 'spec-auth', content: '# Mine\n' } });
  assert.deepEqual(pageConflict, { status: 'conflict', current: { file: join(dir, 'pages', 'spec-auth.md'), text: '# Login (agent)\n', digest: sha('# Login (agent)\n') } });
  assert.equal(await readFile(join(dir, 'pages', 'spec-auth.md'), 'utf8'), '# Login (agent)\n');

  // A new page whose file already exists (not in docs.yaml) is not overwritten either.
  await writeFile(join(dir, 'pages', 'notes.md'), 'by hand\n');
  assert.equal((await saveWikiPage(dir, { baseDigest: wiki.docs.digest, page: { slug: 'notes', content: '# Notes\n' } })).status, 'conflict');
  assert.equal(await readFile(join(dir, 'pages', 'notes.md'), 'utf8'), 'by hand\n');

  const byAgent = `${DOCS}  - target: AUTH-LOGIN\n    file: files/login-flow.pdf\n`;
  await writeFile(join(dir, 'docs.yaml'), byAgent);
  const docsConflict = await saveWikiPage(dir, { baseDigest: wiki.docs.digest, page: { slug: 'faq', content: '# FAQ\n' } });
  assert.equal(docsConflict.status, 'conflict');
  assert.equal(docsConflict.status === 'conflict' && docsConflict.current.text, byAgent);
  assert.equal(await docsText(dir), byAgent);
  await assert.rejects(readFile(join(dir, 'pages', 'faq.md')), { code: 'ENOENT' });
});

test('two wiki adds from the same docs.yaml: one is saved, the other is a conflict and leaves no page behind', async (t) => {
  const dir = await docsProject(t);
  const base = await readManifestFile(dir, 'docs');
  const results = await Promise.all(
    ['faq', 'glossary'].map((slug) => saveWikiPage(dir, { baseDigest: base.digest, page: { slug, content: `# ${slug}\n` } })),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), ['conflict', 'saved']);
  const listed = (await readWikiPages(dir)).pages.map((page) => page.file).sort();
  const files = (await readdir(join(dir, 'pages'))).map((name) => `pages/${name}`).sort();
  assert.deepEqual(files, listed, 'every file under pages/ is in docs.yaml');

  // The conflicting add goes through on the current docs.yaml.
  const conflict = results.find((result) => result.status === 'conflict')!;
  const slug = results[0]!.status === 'conflict' ? 'faq' : 'glossary';
  saved(await saveWikiPage(dir, { baseDigest: conflict.status === 'conflict' ? conflict.current.digest : '', page: { slug, content: `# ${slug}\n` } }));
  assert.equal((await readWikiPages(dir)).pages.length, 3);
});

test('wiki slugs follow the loader rules; issues elsewhere in docs.yaml do not block a save', async (t) => {
  // An attachment with a bad name is not under the edited entry.
  const docs = `${DOCS}  - target: wiki:spec-auth\n    file: files/Login Flow.pdf\n`;
  const dir = await docsProject(t, docs);
  await writeFile(join(dir, 'files', 'Login Flow.pdf'), 'pdf');
  const base = await readManifestFile(dir, 'docs');
  const attempts: [string, { path: string; rule: string }[]][] = [
    ['Spec Billing', [{ path: 'wiki[1].slug', rule: 'wiki-slug' }]],
    ['../escape', [{ path: 'wiki[1].slug', rule: 'wiki-slug' }]],
    ['spec-auth', [{ path: 'wiki[1].slug', rule: 'wiki-slug-unique' }]],
  ];
  for (const [slug, issues] of attempts) {
    assert.deepEqual(issuesOf(await saveWikiPage(dir, { baseDigest: base.digest, page: { slug, content: '# Page\n' } })), issues, slug);
  }
  assert.deepEqual(
    issuesOf(await saveWikiPage(dir, { baseDigest: base.digest, pageDigest: sha(''), page: { slug: 'missing', content: '# Page\n' } })),
    [{ path: '', rule: 'wiki-reference' }],
  );
  assert.equal(await docsText(dir), docs, 'nothing is written');
  await assert.rejects(readFile(join(dir, 'escape.md')), { code: 'ENOENT' });

  saved(await saveWikiPage(dir, { baseDigest: base.digest, page: { slug: 'spec-billing', content: '# Billing\n' } }));
  assert.equal(await readFile(join(dir, 'pages', 'spec-billing.md'), 'utf8'), '# Billing\n');
});

test('the first wiki page of a project without docs.yaml creates the file', async (t) => {
  const dir = await docsProject(t, null);
  const empty = await readWikiPages(dir);
  assert.deepEqual([empty.docs.text, empty.pages], ['', []]);
  saved(await saveWikiPage(dir, { baseDigest: empty.docs.digest, page: { slug: 'home-notes', content: '# Notes\n' } }));
  assert.equal(await docsText(dir), 'wiki:\n  - slug: home-notes\n    file: pages/home-notes.md\n');
});

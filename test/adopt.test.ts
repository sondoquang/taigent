// Adopt a hand-made item (spec #53, tickets #57 and #58): `taigent adopt` writes the item from Taiga into
// backlog.yaml with its `ref` (a story under a manifest epic, a task under a manifest story), plan proposes the
// `adopt` action and apply only adds the `src:<key>` tag.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { ExitCode } from '../src/exit-codes.ts';
import type { ApplyReport } from '../src/executor.ts';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import type { Plan } from '../src/planner.ts';
import { valueId } from './support/backlog.ts';
import { startHarness, writes, type Harness } from './support/harness.ts';

interface ErrorOutput {
  error: { kind: string; message: string; issues?: ManifestIssue[] };
}

async function readBacklog(h: Harness, slug = 'demo'): Promise<unknown> {
  return parse(await readFile(join(h.manifestsDir, slug, 'backlog.yaml'), 'utf8'));
}

test('adopting a hand-made epic writes it verbatim; plan proposes only adopt and apply writes only its src: tag', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const description = 'Pay by card or transfer.  \nLine with trailing spaces   \n\n- [ ] a checklist\n';
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments', description, tags: ['type:feature', 'area:payments', 'frontend', 'type:weird'] });

  const adopted = await h.taigent(['adopt', '--project', 'demo', '--ref', String(epic.ref), '--key', 'PAY', '--json']);

  assert.equal(adopted.code, 0, adopted.stderr);
  assert.deepEqual(adopted.json(), { project: { id: project.id, slug: 'demo' }, type: 'epic', key: 'PAY', ref: epic.ref, id: epic.id, path: 'epics[0]' });
  assert.deepEqual(writes(h.fake), [], 'adopt writes the manifest only');
  // Verbatim subject and description, only the tags with a prefix the manifest allows; no custom attributes.
  assert.deepEqual(await readBacklog(h), { epics: [{ key: 'PAY', ref: epic.ref, subject: 'Payments', description, tags: ['type:feature', 'area:payments'] }] });

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const { operations, summary } = plan.json<Plan>();
  assert.deepEqual(operations, [
    {
      action: 'adopt',
      type: 'epic',
      key: 'PAY',
      id: epic.id,
      ref: epic.ref,
      version: epic.version,
      changes: { tags: { from: ['type:feature', 'area:payments', 'frontend', 'type:weird'], to: ['type:feature', 'area:payments', 'frontend', 'type:weird', 'src:pay'] } },
    },
  ]);
  assert.deepEqual(summary, { create: 0, update: 0, adopt: 1, link: 0, skip: 0 });

  const applied = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(writes(h.fake), [`PATCH /epics/${epic.id}`]);
  const patch = h.fake.requests.find((r) => r.method === 'PATCH')!;
  assert.deepEqual(patch.body, { tags: ['type:feature', 'area:payments', 'frontend', 'type:weird', 'src:pay'], version: 1 });
  const report = applied.json<ApplyReport>();
  assert.deepEqual(report.operations.map((op) => [op.action, op.key, op.ref, op.result]), [['adopt', 'PAY', epic.ref, 'adopted']]);
  assert.deepEqual(report.summary, { created: 0, updated: 0, adopted: 1, linked: 0, unchanged: 0 });
  assert.equal(h.fake.state.epics[0]!.subject, 'Payments');
  assert.equal(h.fake.state.epics[0]!.description, description);
  // The adopt records the item's first baseline: Taiga's managed values, the content being the manifest's already.
  assert.deepEqual((await h.readState('demo'))!.items.PAY, {
    type: 'epic',
    id: epic.id,
    ref: epic.ref,
    version: 2,
    baseline: { subject: 'Payments', description, tags: ['type:feature', 'area:payments', 'type:weird'], custom_attributes: {} },
  });

  // Once tagged, the item is the backlog item: `ref` stays as an assertion and the plan has nothing to do.
  const again = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json<Plan>().operations.map((op) => [op.action, op.key]), [['skip', 'PAY']]);
});

test('an adopted epic is never blocked before its adopt; after apply, a subject edited on Taiga is a remote edit (exit 6)', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments', description: 'Pay by card.', tags: ['type:feature'] });
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(epic.ref), '--key', 'PAY'])).code, 0);
  // A manifest edit before the first apply is part of the adopt, not an `unknown` difference: there is no baseline yet.
  await h.writeManifest('demo', 'backlog.yaml', `epics:\n  - key: PAY\n    ref: ${epic.ref}\n    subject: Payments and refunds\n    description: Pay by card.\n    tags: [type:feature]\n`);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  assert.deepEqual(plan.json<Plan>().blocked, []);
  assert.deepEqual(plan.json<Plan>().operations.map((op) => [op.action, op.key, 'changes' in op ? Object.keys(op.changes) : []]), [['adopt', 'PAY', ['subject', 'tags']]]);
  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual((await h.readState('demo'))!.items.PAY!.baseline, { subject: 'Payments and refunds', description: 'Pay by card.', tags: ['type:feature'], custom_attributes: {} });

  h.fake.editItem(h.fake.state.epics[0]!, { subject: 'Payments (Q3)' });
  h.fake.requests.length = 0;
  const edited = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(edited.code, ExitCode.Blocked, edited.stderr);
  const blockedPlan = edited.json<Plan>();
  assert.deepEqual(blockedPlan.operations, []);
  assert.deepEqual(blockedPlan.blocked, [
    { kind: 'remote-edit', type: 'epic', key: 'PAY', id: epic.id, ref: epic.ref, fields: { subject: { baseline: 'Payments and refunds', taiga: 'Payments (Q3)', manifest: 'Payments and refunds' } } },
  ]);
  const refused = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(refused.code, ExitCode.Blocked, refused.stderr);
  assert.deepEqual(writes(h.fake), []);
});

test('adopting a hand-made issue copies its type, severity and priority by name, after the items already in backlog.yaml', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const id = (list: Parameters<typeof valueId>[1], name: string) => valueId(h, list, project.id, name);
  const issue = h.fake.addIssue({
    project: project.id,
    subject: 'Export fails on large files',
    description: 'Steps:\r\n1. Export 2 GB\r\n',
    tags: ['type:bug', 'urgent'],
    type: id('issueTypes', 'Bug'),
    severity: id('severities', 'Critical'),
    priority: id('priorities', 'High'),
    status: id('issueStatuses', 'In progress'),
  });
  const existing = '# Payments backlog\nepics:\n  - key: PAY # the payments epic\n    subject: Payments\n';
  await h.writeManifest('demo', 'backlog.yaml', existing);

  const adopted = await h.taigent(['adopt', '--project', 'demo', '--ref', `#${issue.ref}`, '--key', 'BUG-EXPORT']);

  assert.equal(adopted.code, 0, adopted.stderr);
  assert.match(adopted.stdout, new RegExp(`Adopted issue #${issue.ref} \\(id ${issue.id}\\) as BUG-EXPORT at issues\\[0\\]`));
  const text = await readFile(join(h.manifestsDir, 'demo', 'backlog.yaml'), 'utf8');
  assert.ok(text.startsWith(existing), `the items and comments already there stay as written:\n${text}`);
  assert.deepEqual(parse(text), {
    epics: [{ key: 'PAY', subject: 'Payments' }],
    issues: [
      { key: 'BUG-EXPORT', ref: issue.ref, subject: 'Export fails on large files', description: 'Steps:\r\n1. Export 2 GB\r\n', type: 'Bug', severity: 'Critical', priority: 'High', tags: ['type:bug'] },
    ],
  });

  h.fake.addEpic({ project: project.id, subject: 'Payments', tags: ['src:pay'] });
  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  assert.deepEqual(
    plan.json<Plan>().operations.map((op) => [op.action, op.key, 'changes' in op ? op.changes : undefined]),
    [
      ['skip', 'PAY', undefined],
      ['adopt', 'BUG-EXPORT', { tags: { from: ['type:bug', 'urgent'], to: ['type:bug', 'urgent', 'src:bug-export'] } }],
    ],
  );
  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(writes(h.fake), [`PATCH /issues/${issue.id}`]);
  assert.equal(h.fake.state.issues[0]!.status, id('issueStatuses', 'In progress'), 'the status set on Taiga stays');
});

test('adopt refuses a closed item, an item already tagged src:, an unknown ref and a used key or ref; it writes nothing', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const closed = h.fake.addIssue({ project: project.id, subject: 'Old bug', status: valueId(h, 'issueStatuses', project.id, 'Closed') });
  const tagged = h.fake.addEpic({ project: project.id, subject: 'Accounts', tags: ['src:account'] });
  const free = h.fake.addEpic({ project: project.id, subject: 'Free epic' });

  const refused = async (ref: number, key: string, message: RegExp) => {
    const result = await h.taigent(['adopt', '--project', 'demo', '--ref', String(ref), '--key', key, '--json']);
    assert.equal(result.code, 2, `${ref}: ${result.stderr}`);
    const { error } = result.json<ErrorOutput>();
    assert.equal(error.kind, 'usage');
    assert.match(error.message, message);
  };
  await refused(closed.ref, 'BUG-OLD', new RegExp(`issue #${closed.ref} is closed`));
  await refused(tagged.ref, 'ACCOUNTS', new RegExp(`epic #${tagged.ref} already carries src:account: it is backlog item ACCOUNT`));
  await refused(999, 'NOTHING', /no epic, user story, task or issue #999 in project demo/);
  assert.deepEqual(writes(h.fake), []);
  await assert.rejects(readFile(join(h.manifestsDir, 'demo', 'backlog.yaml')), { code: 'ENOENT' });

  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(free.ref), '--key', 'FREE'])).code, 0);
  const before = await readFile(join(h.manifestsDir, 'demo', 'backlog.yaml'), 'utf8');
  await refused(free.ref, 'FREE-AGAIN', new RegExp(`#${free.ref} is already adopted by FREE in backlog.yaml`));
  await refused(closed.ref, 'FREE', /key FREE is already in backlog.yaml/);
  assert.equal(await readFile(join(h.manifestsDir, 'demo', 'backlog.yaml'), 'utf8'), before);

  for (const args of [['--key', 'X'], ['--ref', '1'], ['--ref', 'abc', '--key', 'X'], ['--ref', '1', '--key', 'lower'], ['--ref', '1', '--key', 'X', '--epic', 'A', '--story', 'B'], ['--ref', '1', '--key', 'X', '--epic', 'lower']]) {
    assert.equal((await h.taigent(['adopt', '--project', 'demo', ...args])).code, 2, args.join(' '));
  }
  assert.equal((await h.taigent(['plan', '--project', 'demo', '--ref', '1'])).code, 2, '--ref applies only to adopt');
  assert.equal((await h.taigent(['plan', '--project', 'demo', '--epic', 'A'])).code, 2, '--epic applies only to adopt');
  assert.equal((await h.taigent(['plan', '--project', 'demo', '--story', 'A'])).code, 2, '--story applies only to adopt');
});

test('plan and apply fail with item-ref when a ref does not match Taiga, before any write', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const tagged = h.fake.addEpic({ project: project.id, subject: 'Accounts', tags: ['src:account'] });
  const other = h.fake.addEpic({ project: project.id, subject: 'Other' });
  const story = h.fake.addUserStory({ project: project.id, subject: 'Hand-made story' });
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: ACCOUNT
    ref: ${other.ref}
    subject: Accounts
  - key: WRONG-TYPE
    ref: ${story.ref}
    subject: A story, not an epic
  - key: TAKEN
    ref: ${tagged.ref}
    subject: Accounts again
  - key: MISSING
    ref: 999
    subject: Nowhere
`,
  );

  for (const args of [['plan'], ['apply', '--yes']]) {
    const result = await h.taigent([...args, '--project', 'demo', '--json']);
    assert.equal(result.code, 4, result.stderr);
    const { error } = result.json<ErrorOutput>();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(
      error.issues?.map((issue) => [issue.path, issue.rule, issue.message]),
      [
        ['epics[0].ref', 'item-ref', `ACCOUNT: ACCOUNT is #${tagged.ref} on Taiga (tagged src:account), not #${other.ref}`],
        ['epics[1].ref', 'item-ref', `WRONG-TYPE: #${story.ref} is a user story on Taiga, not an epic`],
        ['epics[2].ref', 'item-ref', `TAKEN: #${tagged.ref} already carries src:account (backlog item ACCOUNT); one Taiga item is never bound to two backlog items`],
        ['epics[3].ref', 'item-ref', 'MISSING: no epic, user story, task or issue #999 in project demo'],
      ],
    );
  }
  assert.deepEqual(writes(h.fake), []);

  await h.writeManifest('demo', 'backlog.yaml', `epics:\n  - key: A\n    ref: ${other.ref}\n    subject: A\n  - key: B\n    ref: ${other.ref}\n    subject: B\n  - key: C\n    ref: 0\n    subject: C\n`);
  const validated = await h.taigent(['validate', '--project', 'demo', '--json']);
  assert.equal(validated.code, 4, validated.stderr);
  assert.deepEqual(validated.json<ErrorOutput>().error.issues?.map((issue) => [issue.path, issue.rule]), [['epics[1].ref', 'ref-unique'], ['epics[2].ref', 'type']]);
});

test('hand-made stories under a backlog epic and hand-made tasks in a backlog story are listed apart, never as stale links, and left untouched', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const handMadeEpic = h.fake.addEpic({ project: project.id, subject: 'Payments' });
  const cardStory = h.fake.addUserStory({ project: project.id, subject: 'Pay by card' });
  h.fake.addEpicRelatedUserStory(handMadeEpic.id, cardStory.id);
  const accounts = h.fake.addEpic({ project: project.id, subject: 'Accounts', tags: ['src:account'] });
  const login = h.fake.addUserStory({ project: project.id, subject: 'Sign in', description: 'As a user I sign in.', tags: ['src:account-login'] });
  h.fake.addEpicRelatedUserStory(accounts.id, login.id);
  const resetStory = h.fake.addUserStory({ project: project.id, subject: 'Reset password' });
  h.fake.addEpicRelatedUserStory(accounts.id, resetStory.id);
  const apiTask = h.fake.addTask({ project: project.id, subject: 'Login endpoint', user_story: login.id });
  // A hand-made story linked to two backlog epics is listed under both; it is never a stale link.
  h.fake.addEpicRelatedUserStory(handMadeEpic.id, resetStory.id);
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: ACCOUNT
    subject: Accounts
    stories:
      - key: ACCOUNT-LOGIN
        subject: Sign in
        description: As a user I sign in.
`,
  );
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(handMadeEpic.ref), '--key', 'PAY'])).code, 0);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const { operations, staleLinks, handMadeChildren } = plan.json<Plan>();
  assert.deepEqual(operations.map((op) => [op.action, op.key]), [['skip', 'ACCOUNT'], ['skip', 'ACCOUNT-LOGIN'], ['adopt', 'PAY']]);
  assert.deepEqual(staleLinks, []);
  assert.deepEqual(handMadeChildren, [
    { type: 'story', id: resetStory.id, ref: resetStory.ref, subject: 'Reset password', parent: 'ACCOUNT' },
    { type: 'task', id: apiTask.id, ref: apiTask.ref, subject: 'Login endpoint', parent: 'ACCOUNT-LOGIN' },
    { type: 'story', id: cardStory.id, ref: cardStory.ref, subject: 'Pay by card', parent: 'PAY' },
    { type: 'story', id: resetStory.id, ref: resetStory.ref, subject: 'Reset password', parent: 'PAY' },
  ]);
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.match(text.stdout, /Hand-made children \(on Taiga under a backlog item/);
  assert.ok(text.stdout.includes(`  - hand-made story #${cardStory.ref} (id ${cardStory.id})  "Pay by card"  in epic PAY`), text.stdout);

  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(writes(h.fake), [`PATCH /epics/${handMadeEpic.id}`], 'hand-made children and their links are never touched');
});

test('adopting a free-text story under a backlog epic keeps its whole description verbatim (CRLF, trailing whitespace) in the legacy format: plan has no content update', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments' });
  const description = 'Customers pay by card.  \r\n\r\nAcceptance:\r\n- [ ] Visa works   \r\n- [x] Mastercard works\t\r\n\r\n';
  const story = h.fake.addUserStory({ project: project.id, subject: 'Pay by card', description, tags: ['area:payments', 'urgent'] });
  h.fake.addEpicRelatedUserStory(epic.id, story.id);
  const task = h.fake.addTask({ project: project.id, subject: 'Card form', description: 'Form fields.  \r\n', user_story: story.id });
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(epic.ref), '--key', 'PAY'])).code, 0);

  const adopted = await h.taigent(['adopt', '--project', 'demo', '--ref', String(story.ref), '--key', 'PAY-CARD', '--epic', 'PAY', '--json']);

  assert.equal(adopted.code, 0, adopted.stderr);
  assert.deepEqual(adopted.json(), { project: { id: project.id, slug: 'demo' }, type: 'story', key: 'PAY-CARD', ref: story.ref, id: story.id, path: 'epics[0].stories[0]' });
  assert.deepEqual(writes(h.fake), [], 'adopt writes the manifest only');
  // Legacy format: the whole description as it is, no acceptance criteria split out of it.
  assert.deepEqual(await readBacklog(h), {
    epics: [{ key: 'PAY', ref: epic.ref, subject: 'Payments', stories: [{ key: 'PAY-CARD', ref: story.ref, subject: 'Pay by card', description, tags: ['area:payments'] }] }],
  });

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const { operations, handMadeChildren } = plan.json<Plan>();
  assert.deepEqual(
    operations.map((op) => [op.action, op.key, 'changes' in op ? Object.keys(op.changes) : []]),
    [['adopt', 'PAY', ['tags']], ['adopt', 'PAY-CARD', ['tags']]],
    'adopting changes nothing but the src: tag: no content update, no link',
  );
  // The hand-made task in the adopted story is listed apart, never touched.
  assert.deepEqual(handMadeChildren, [{ type: 'task', id: task.id, ref: task.ref, subject: 'Card form', parent: 'PAY-CARD' }]);

  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(writes(h.fake), [`PATCH /epics/${epic.id}`, `PATCH /userstories/${story.id}`]);
  assert.deepEqual(h.fake.requests.filter((r) => r.method === 'PATCH').at(-1)!.body, { tags: ['area:payments', 'urgent', 'src:pay-card'], version: 1 });
  assert.equal(h.fake.state.userStories[0]!.description, description);
  const again = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.json<Plan>().operations.map((op) => [op.action, op.key]), [['skip', 'PAY'], ['skip', 'PAY-CARD']]);

  // The task, now in a backlog story, is adopted under it: verbatim too.
  const adoptedTask = await h.taigent(['adopt', '--project', 'demo', '--ref', String(task.ref), '--key', 'PAY-CARD-FORM', '--story', 'PAY-CARD', '--json']);
  assert.equal(adoptedTask.code, 0, adoptedTask.stderr);
  assert.equal(adoptedTask.json<{ path: string }>().path, 'epics[0].stories[0].tasks[0]');
  const withTask = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(withTask.code, 3, withTask.stderr);
  const taskPlan = withTask.json<Plan>();
  assert.deepEqual(
    taskPlan.operations.map((op) => [op.action, op.key, 'changes' in op ? Object.keys(op.changes) : []]),
    [['skip', 'PAY', []], ['skip', 'PAY-CARD', []], ['adopt', 'PAY-CARD-FORM', ['tags']]],
  );
  assert.deepEqual(taskPlan.handMadeChildren, []);
});

test('an adopted legacy story is planned, but a new story in the legacy format is still refused by story-format', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments' });
  const story = h.fake.addUserStory({ project: project.id, subject: 'Pay by card', description: 'Free text.' });
  h.fake.addEpicRelatedUserStory(epic.id, story.id);
  await h.writeManifest(
    'demo',
    'backlog.yaml',
    `epics:
  - key: PAY
    ref: ${epic.ref}
    subject: Payments
    stories:
      - key: PAY-CARD
        ref: ${story.ref}
        subject: Pay by card
        description: Free text.
      - key: PAY-CASH
        subject: Pay cash
        description: Free text too.
`,
  );

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 4, plan.stderr);
  assert.deepEqual(plan.json<ErrorOutput>().error.issues?.map((issue) => [issue.path, issue.rule]), [['epics[0].stories[1]', 'story-format']]);
  assert.deepEqual(writes(h.fake), []);
});

test('adopt takes a story only under a manifest epic and a task only under the backlog story it is in on Taiga; otherwise it refuses and writes nothing', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments' });
  const otherEpic = h.fake.addEpic({ project: project.id, subject: 'Shipping' });
  const story = h.fake.addUserStory({ project: project.id, subject: 'Pay by card' });
  const handMadeStory = h.fake.addUserStory({ project: project.id, subject: 'Pay cash' });
  const inStory = h.fake.addTask({ project: project.id, subject: 'Card form', user_story: story.id });
  const inHandMade = h.fake.addTask({ project: project.id, subject: 'Cash drawer', user_story: handMadeStory.id });
  const loose = h.fake.addTask({ project: project.id, subject: 'Loose task' });
  const issue = h.fake.addIssue({ project: project.id, subject: 'Bug' });
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(epic.ref), '--key', 'PAY'])).code, 0);
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(story.ref), '--key', 'PAY-CARD', '--epic', 'PAY'])).code, 0);
  const before = await readFile(join(h.manifestsDir, 'demo', 'backlog.yaml'), 'utf8');

  const refused = async (ref: number, parent: string[], message: RegExp) => {
    const result = await h.taigent(['adopt', '--project', 'demo', '--ref', String(ref), '--key', 'NEW', ...parent, '--json']);
    assert.equal(result.code, 2, `${ref} ${parent.join(' ')}: ${result.stderr}`);
    const { error } = result.json<ErrorOutput>();
    assert.equal(error.kind, 'usage');
    assert.match(error.message, message);
  };
  await refused(handMadeStory.ref, [], new RegExp(`user story #${handMadeStory.ref} goes under an epic of backlog.yaml: add --epic <KEY>`));
  await refused(handMadeStory.ref, ['--epic', 'SHIP'], /--epic SHIP is not an epic of backlog.yaml/);
  await refused(handMadeStory.ref, ['--epic', 'PAY-CARD'], /--epic PAY-CARD is not an epic of backlog.yaml/);
  await refused(handMadeStory.ref, ['--story', 'PAY-CARD'], new RegExp(`user story #${handMadeStory.ref} goes under an epic of backlog.yaml: add --epic <KEY>, not --story`));
  await refused(inHandMade.ref, [], new RegExp(`task #${inHandMade.ref} goes under a story of backlog.yaml: add --story <KEY>`));
  await refused(inStory.ref, ['--story', 'PAY'], /--story PAY is not a story of backlog.yaml/);
  await refused(inHandMade.ref, ['--story', 'PAY-CARD'], new RegExp(`task #${inHandMade.ref} is in user story #${handMadeStory.ref}, which is not a backlog item; adopt that story first`));
  await refused(loose.ref, ['--story', 'PAY-CARD'], new RegExp(`task #${loose.ref} is in no user story`));
  await refused(otherEpic.ref, ['--epic', 'PAY'], new RegExp(`epic #${otherEpic.ref} sits at the top of backlog.yaml: drop --epic`));
  await refused(issue.ref, ['--story', 'PAY-CARD'], new RegExp(`issue #${issue.ref} sits at the top of backlog.yaml: drop --story`));
  assert.equal(await readFile(join(h.manifestsDir, 'demo', 'backlog.yaml'), 'utf8'), before);
  assert.deepEqual(writes(h.fake), []);

  // Once its story is adopted, the task can be: a task in another backlog story than --story is still refused.
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(handMadeStory.ref), '--key', 'PAY-CASH', '--epic', 'PAY'])).code, 0);
  await refused(inHandMade.ref, ['--story', 'PAY-CARD'], new RegExp(`task #${inHandMade.ref} is in user story #${handMadeStory.ref}, which is backlog item PAY-CASH, not PAY-CARD`));
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(inHandMade.ref), '--key', 'PAY-CASH-DRAWER', '--story', 'PAY-CASH'])).code, 0);
});

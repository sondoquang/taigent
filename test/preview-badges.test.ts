// Badges of `taigent preview` (spec #53, ticket #61): "adopt #ref" for a backlog item adopting a hand-made item until
// apply records it, and the remote edits, conflicts and unknowns that snapshot.json shows against the state.json
// baseline, computed offline and dated by the snapshot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ExitCode } from '../src/exit-codes.ts';
import type { Preview } from '../src/review.ts';
import type { Snapshot } from '../src/snapshot.ts';
import { applied } from './support/backlog.ts';
import { OFFLINE, startHarness, type Harness } from './support/harness.ts';

/** Preview works offline, without any TAIGA_* variable. */
async function preview(h: Harness): Promise<{ json: Preview; page: string }> {
  const json = await h.taigent(['preview', '--project', 'demo', '--json'], { env: OFFLINE });
  assert.equal(json.code, 0, json.stderr);
  const page = await h.taigent(['preview', '--project', 'demo'], { env: OFFLINE });
  assert.equal(page.code, 0, page.stderr);
  return { json: json.json<Preview>(), page: page.stdout };
}

/** One epic AUTH. */
const EPIC = 'epics:\n  - key: AUTH\n    subject: Authentication\n    tags: [type:feature]\n';

/** Runs `taigent snapshot` and returns its readAt. */
async function snapshot(h: Harness): Promise<string> {
  const result = await h.taigent(['snapshot', '--project', 'demo']);
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(await readFile(join(h.manifestsDir, 'demo', 'snapshot.json'), 'utf8')) as Snapshot).readAt;
}

/** `2026-11-03T08:15:00.000Z` → `2026-11-03 08:15 UTC`, as the page shows it. */
const shown = (readAt: string) => `${readAt.slice(0, 16).replace('T', ' ')} UTC`;

test('preview shows "adopt #ref" for an item adopting a hand-made one until apply records it', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Payments', description: 'Pay by card.', tags: ['type:feature'] });
  assert.equal((await h.taigent(['adopt', '--project', 'demo', '--ref', String(epic.ref), '--key', 'PAY'])).code, 0);

  const before = await preview(h);
  assert.deepEqual(before.json.epics[0]!.adopt, { ref: epic.ref });
  assert.equal(before.json.epics[0]!.applied, undefined);
  assert.deepEqual([before.json.summary.new, before.json.summary.adopt, before.json.summary.applied], [0, 1, 0]);
  assert.match(before.page, new RegExp(`^adopt #${epic.ref} \\(hand-made on Taiga\\)`, 'm'));
  assert.match(before.page, /\| To adopt \(hand-made on Taiga\) \| 1 \|/);

  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  const after = await preview(h);
  assert.equal(after.json.epics[0]!.adopt, undefined);
  assert.deepEqual(after.json.epics[0]!.applied, { id: epic.id, ref: epic.ref });
  assert.deepEqual([after.json.summary.new, after.json.summary.adopt, after.json.summary.applied], [0, 0, 1]);
  assert.doesNotMatch(after.page, /adopt #/);
});

test('preview shows a remote edit from snapshot.json with its readAt, and no remote badge without a snapshot', async (t) => {
  const h = await startHarness(t);
  await applied(h, EPIC);
  h.fake.editItem(h.fake.state.epics[0]!, { subject: 'Login' });

  const without = await preview(h);
  assert.equal(without.json.snapshot, undefined);
  assert.equal(without.json.epics[0]!.blocked, undefined);
  assert.deepEqual(without.json.summary.blocked, { 'remote-edit': 0, conflict: 0, unknown: 0 });
  assert.doesNotMatch(without.page, /remote edit/);
  assert.match(without.page, /No snapshot\.json: run `taigent snapshot --project demo`/);

  const readAt = await snapshot(h);
  h.fake.requests.length = 0;
  const { json, page } = await preview(h);
  assert.deepEqual(json.snapshot, { readAt });
  assert.deepEqual(json.epics[0]!.blocked, { kind: 'remote-edit', fields: ['subject'] });
  assert.deepEqual(json.summary.blocked, { 'remote-edit': 1, conflict: 0, unknown: 0 });
  assert.match(page, new RegExp(`Taiga as \`taigent snapshot\` read it at ${shown(readAt)}`));
  assert.match(page, new RegExp(`^on Taiga #\\d+ · \\*\\*remote edit on Taiga\\*\\* \\(snapshot ${shown(readAt)}\\): subject`, 'm'));
  assert.match(page, /\| Edited on Taiga \(remote edit\) \| 1 \|/);
  assert.deepEqual(h.fake.requests, [], 'preview stays offline');
});

test('a snapshot read before taigent last wrote an item shows no remote edit for it', async (t) => {
  const h = await startHarness(t);
  await applied(h, EPIC);
  await snapshot(h);
  await h.writeManifest('demo', 'backlog.yaml', 'epics:\n  - key: AUTH\n    subject: Sign-in\n    tags: [type:feature]\n');
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);

  const { json } = await preview(h);
  assert.equal(json.epics[0]!.blocked, undefined);
  assert.deepEqual(json.summary.blocked, { 'remote-edit': 0, conflict: 0, unknown: 0 });
});

const TREE = `epics:
  - key: AUTH
    subject: Authentication
    tags: [type:feature]
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        use_case: { as_a: user, i_want_to: log in, so_that: I see my projects }
        scenarios:
          - { scenario: Wrong password, given: [I am on the sign-in page], when: I submit a wrong password, then: I see an error }
        tags: [type:feature]
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
      - key: AUTH-LOGOUT
        subject: User can log out
        use_case: { as_a: user, i_want_to: log out, so_that: nobody else uses my session }
        scenarios:
          - { scenario: Log out, given: [I am signed in], when: I log out, then: I see the sign-in page }
issues:
  - key: BUG-CRASH
    subject: Crash on login
    type: Bug
    severity: Critical
    priority: High
`;

test('preview compares every item type with the snapshot: nothing right after apply, then each edit, conflict and unknown', async (t) => {
  const h = await startHarness(t);
  await applied(h, TREE);
  await snapshot(h);
  const clean = await preview(h);
  const all = (p: Preview) => [...p.epics.flatMap((e) => [e, ...e.stories.flatMap((s) => [s, ...s.tasks])]), ...p.issues];
  assert.deepEqual(all(clean.json).flatMap((item) => (item.blocked ? [item.key] : [])), []);

  const { state } = h.fake;
  const [login, logout] = state.userStories;
  const minor = state.severities.find((value) => value.name === 'Minor')!;
  h.fake.editItem(state.issues[0]!, { severity: minor.id });
  h.fake.editItem(state.tasks[0]!, { user_story: logout!.id });
  h.fake.editItem(login!, { tags: [...login!.tags, 'type:bug'] });
  h.fake.editItem(state.epics[0]!, { subject: 'Login' });
  // An epic tagged by an older taigent, never recorded in state.json, that differs from the manifest.
  h.fake.addEpic({ project: state.projects[0]!.id, subject: 'Billing on Taiga', tags: ['src:billing'] });
  await h.writeManifest('demo', 'backlog.yaml', TREE.replace('subject: Authentication', 'subject: Sign-in').replace('issues:', '  - key: BILLING\n    subject: Billing\nissues:'));
  await snapshot(h);

  const { json, page } = await preview(h);
  assert.deepEqual(
    all(json).flatMap((item) => (item.blocked ? [[item.key, item.blocked.kind, item.blocked.fields]] : [])),
    [
      ['AUTH', 'conflict', ['subject']],
      ['AUTH-LOGIN', 'remote-edit', ['tags']],
      ['AUTH-LOGIN-API', 'remote-edit', ['story']],
      ['BILLING', 'unknown', ['subject']],
      ['BUG-CRASH', 'remote-edit', ['severity']],
    ],
  );
  assert.deepEqual(json.summary.blocked, { 'remote-edit': 3, conflict: 1, unknown: 1 });
  assert.match(page, /\*\*conflict with Taiga\*\* \(snapshot [^)]+\): subject/);
  assert.match(page, /\*\*unknown: differs from Taiga, no baseline\*\* \(snapshot [^)]+\): subject/);

  // Plan, reading Taiga itself, blocks the same items the same way.
  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, ExitCode.Blocked, plan.stderr);
  const blocked = plan.json<{ blocked: { key: string; kind: string; fields: Record<string, unknown> }[] }>().blocked;
  assert.deepEqual(
    blocked.map((item) => [item.key, item.kind, Object.keys(item.fields)]).sort(),
    all(json).flatMap((item) => (item.blocked ? [[item.key, item.blocked.kind, item.blocked.fields]] : [])).sort(),
  );
});

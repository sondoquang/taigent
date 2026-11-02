import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga } from './support/fake-taiga.ts';
import { startHarness } from './support/harness.ts';

interface StatusJson {
  ticket: { id: number; ref: number; subject: string; project: { slug: string } };
  from: string;
  to: string;
  isClosed: boolean;
  changed: boolean;
}

/** A project with one open ticket of the fake user (`In progress`) and one story of someone else. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other] });
  const mine = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Login form' }), { assigned_users: [me], status_name: 'In progress' });
  const theirs = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Their story' }), { assigned_users: [other] });
  return { alpha, mine, theirs };
}

const patches = (fake: FakeTaiga) => fake.requests.filter((request) => request.method === 'PATCH');

test('status moves your ticket to the named status at once (any case, words unquoted) and closes it on Done', async (t) => {
  const h = await startHarness(t);
  const { mine } = seed(h.fake);

  const ready = await h.taigent(['status', '--project', 'alpha', String(mine.ref), 'ready', 'for', 'TEST']);
  assert.equal(ready.code, 0, ready.stderr);
  assert.equal(ready.stdout, `#${mine.ref} Login form (alpha): In progress → Ready for test\n`);
  assert.equal(mine.is_closed, false);

  const done = await h.taigent(['status', '--project', 'alpha', `#${mine.ref}`, 'Done', '--json']);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(done.json<StatusJson>(), {
    ticket: { id: mine.id, ref: mine.ref, subject: 'Login form', project: { id: mine.project, slug: 'alpha', name: 'Alpha' } },
    from: 'Ready for test',
    to: 'Done',
    isClosed: true,
    changed: true,
  });
  assert.equal(mine.is_closed, true);
  assert.equal(mine.status_name, 'Done');
  assert.ok(mine.finish_date !== null, 'closing records the closing time');
});

test('status writes nothing when the ticket already has that status', async (t) => {
  const h = await startHarness(t);
  const { mine } = seed(h.fake);

  const result = await h.taigent(['status', '--project', 'alpha', String(mine.ref), 'In', 'progress', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json<StatusJson>().changed, false);
  assert.deepEqual(patches(h.fake), []);
});

test("status and comment refuse a story that is not yours, an unknown ref or an unknown status (exit 2, nothing written)", async (t) => {
  const h = await startHarness(t);
  const { mine, theirs } = seed(h.fake);

  const notMine = await h.taigent(['status', '--project', 'alpha', String(theirs.ref), 'Done']);
  const unknownRef = await h.taigent(['comment', '--project', 'alpha', '999', 'done']);
  const unknownStatus = await h.taigent(['status', '--project', 'alpha', String(mine.ref), 'Finished']);

  assert.equal(notMine.code, 2);
  assert.match(notMine.stderr, new RegExp(`#${theirs.ref} is not a ticket of taigent-bot in alpha`));
  assert.equal(unknownRef.code, 2);
  assert.match(unknownRef.stderr, /#999 is not a ticket of taigent-bot in alpha/);
  assert.equal(unknownStatus.code, 2);
  assert.match(unknownStatus.stderr, /unknown user story status "Finished" in alpha; use one of: New, Ready, In progress, Ready for test, Done, Archived/);
  assert.deepEqual(patches(h.fake), []);
  assert.equal(theirs.is_closed, false);
});

test('status reports a conflict naming the ticket when someone changed its status meanwhile (exit 5)', async (t) => {
  const h = await startHarness(t);
  const { alpha, mine } = seed(h.fake);
  const ready = h.fake.state.storyStatuses.find((s) => s.project === alpha.id && s.name === 'Ready')!;
  h.fake.onRequest({ method: 'GET', path: '/userstory-statuses', run: () => h.fake.editItem(mine, { status: ready.id, status_name: 'Ready' }) });

  const result = await h.taigent(['status', '--project', 'alpha', String(mine.ref), 'Done', '--json']);

  assert.equal(result.code, 5);
  assert.equal(result.json<{ error: { kind: string; key: string } }>().error.kind, 'conflict');
  assert.equal(result.json<{ error: { kind: string; key: string } }>().error.key, `#${mine.ref}`);
  assert.equal(mine.status_name, 'Ready');
});

test('comment adds the words after the ref as one comment to your ticket', async (t) => {
  const h = await startHarness(t);
  const { mine } = seed(h.fake);

  const result = await h.taigent(['comment', '--project', 'alpha', String(mine.ref), 'Đã', 'test', 'xong', 'trên', 'UAT']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `Commented on #${mine.ref} Login form (alpha)\n`);
  assert.deepEqual(h.fake.state.comments, [{ itemType: 'userstory', item: mine.id, user: h.fake.user.id, comment: 'Đã test xong trên UAT' }]);
  assert.equal(mine.status_name, 'In progress');
});

test('status and comment need --project, a ref and what to write (exit 2 before Taiga is contacted)', async (t) => {
  const h = await startHarness(t);

  for (const args of [['status', '84', 'Done'], ['status', '--project', 'alpha'], ['status', '--project', 'alpha', 'abc', 'Done'], ['status', '--project', 'alpha', '84'], ['comment', '--project', 'alpha', '84']]) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, args.join(' '));
  }
  assert.deepEqual(h.fake.requests, []);
});

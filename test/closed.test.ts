import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga } from './support/fake-taiga.ts';
import { startHarness } from './support/harness.ts';

// UTC+7 without daylight saving: the days 2026-10-26..2026-11-01 run from 2026-10-25T17:00Z to 2026-11-01T17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';
const RANGE = ['--from', '2026-10-26', '--to', '2026-11-01'];

interface ClosedJson {
  summary: { story: number; task: number; issue: number; total: number };
  items: { type: string; ref: number; status: string; project: { slug: string }; closedAt: string }[];
}

/** Two projects holding closed and open stories, tasks and issues of the fake user and of someone else. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const alpha = fake.addProject({ slug: 'alpha', members: [me, other] });
  const beta = fake.addProject({ slug: 'beta', members: [me, other] });
  const story = (project: number, assigned: number[], closedAt: string | null, isClosed = closedAt !== null) =>
    Object.assign(fake.addUserStory({ project, subject: 's' }), { assigned_users: assigned, is_closed: isClosed, finish_date: closedAt });
  const task = (project: number, assigned: number, closedAt: string) =>
    Object.assign(fake.addTask({ project, subject: 't' }), { assigned_to: assigned, is_closed: true, finished_date: closedAt });
  return {
    firstMinute: story(alpha.id, [me], '2026-10-25T17:00:00Z'),
    someoneElses: story(alpha.id, [other], '2026-10-28T00:00:00Z'),
    dayBefore: story(alpha.id, [me], '2026-10-25T16:59:59Z'),
    open: story(alpha.id, [me], null),
    closedWithoutDate: story(alpha.id, [me], null, true),
    lastMinute: story(beta.id, [other, me], '2026-11-01T16:59:00Z'),
    dayAfter: story(beta.id, [me], '2026-11-01T17:00:00Z'),
    myTask: task(beta.id, me, '2026-10-28T03:00:00Z'),
    othersTask: task(alpha.id, other, '2026-10-28T03:00:00Z'),
    myIssue: Object.assign(fake.addIssue({ project: alpha.id, subject: 'i' }), { assigned_to: me, is_closed: true, finished_date: '2026-10-30T08:00:00Z' }),
  };
}

test('closed lists the items assigned to the user that Taiga closed within the days, local time zone, without writing', async (t) => {
  const h = await startHarness(t);
  const items = seed(h.fake);

  const result = await h.taigent(['closed', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<ClosedJson>();
  assert.deepEqual(
    report.items.map(({ type, ref, status, project }) => ({ type, ref, status, project: project.slug })),
    [
      { type: 'story', ref: items.firstMinute.ref, status: 'Done', project: 'alpha' },
      { type: 'task', ref: items.myTask.ref, status: 'Closed', project: 'beta' },
      { type: 'issue', ref: items.myIssue.ref, status: 'Closed', project: 'alpha' },
      { type: 'story', ref: items.lastMinute.ref, status: 'Done', project: 'beta' },
    ],
  );
  assert.deepEqual(report.summary, { story: 2, task: 1, issue: 1, total: 4 });
  assert.deepEqual(
    h.fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth'),
    [],
    'closed only reads',
  );
});

test('closed --project keeps the items of that project only', async (t) => {
  const h = await startHarness(t);
  const items = seed(h.fake);

  const result = await h.taigent(['closed', ...RANGE, '--project', 'beta', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.json<ClosedJson>().items.map(({ ref }) => ref),
    [items.myTask.ref, items.lastMinute.ref],
  );
});

test('closed without a valid day range is a usage error that never contacts Taiga (exit 2)', async (t) => {
  const h = await startHarness(t);

  for (const args of [
    ['closed', '--from', '2026-10-26'],
    ['closed', '--to', '2026-11-01'],
    ['closed', '--from', '2026-02-30', '--to', '2026-03-01'],
    ['closed', '--from', '26/10/2026', '--to', '2026-11-01'],
    ['closed', '--from', '2026-11-02', '--to', '2026-11-01'],
    ['plan', '--project', 'alpha', ...RANGE],
  ]) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stderr}`);
  }
  assert.deepEqual(h.fake.requests, []);
});

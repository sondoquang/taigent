import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness } from './support/harness.ts';

// UTC+7 without daylight saving: the days 2026-10-26..2026-11-01 run from 2026-10-25T17:00Z to 2026-11-01T17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';
const RANGE = ['--from', '2026-10-26', '--to', '2026-11-01'];

interface TicketJson {
  id: number;
  ref: number;
  subject: string;
  status: string;
  isClosed: boolean;
  project: { id: number; slug: string; name: string };
  assignees: (string | number)[];
  dueDate: string | null;
  closedAt: string | null;
  dueStatus: string | null;
}

interface TicketsJson {
  user: { id: number; username: string };
  project: string | null;
  range: { from: string; to: string; start: string; end: string };
  today: string;
  generatedAt: string;
  tickets: TicketJson[];
}

type StoryFields = Partial<Pick<FakeUserStory, 'is_closed' | 'finish_date' | 'due_date' | 'status_name'>> & { assigned?: number[] };

/** Stories of the fake user (and of someone else) in two projects, plus a task and an issue that are not tickets. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const stranger = fake.addUser({ username: 'stranger' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other] });
  const beta = fake.addProject({ slug: 'beta', name: 'Beta', members: [me, other] });
  const story = (project: number, subject: string, { assigned = [me], ...fields }: StoryFields) =>
    Object.assign(fake.addUserStory({ project, subject }), { assigned_users: assigned, is_closed: fields.finish_date != null, ...fields });
  const tickets = {
    dueInRangeClosedBefore: story(alpha.id, 'due in range, closed before', { finish_date: '2026-10-20T03:00:00Z', due_date: '2026-10-28' }),
    closedFirstMinuteOnDueDay: story(alpha.id, 'first minute', { finish_date: '2026-10-25T17:00:00Z', due_date: '2026-10-26' }),
    closedWithoutDueDate: story(alpha.id, 'no due date', { finish_date: '2026-10-28T00:00:00Z' }),
    closedLastMinuteLate: story(beta.id, 'last minute', { finish_date: '2026-11-01T16:59:00Z', due_date: '2026-10-30', assigned: [other, me, stranger] }),
    closedWithoutClosingDay: story(beta.id, 'closed, no closing day', { is_closed: true, due_date: '2026-10-29' }),
    openOverdue: story(beta.id, 'overdue', { due_date: '2000-01-03', status_name: 'In progress' }),
    openOnTrack: story(alpha.id, 'on track', { due_date: '2999-12-31', status_name: 'Ready for test' }),
    openNoDueDate: story(alpha.id, 'open', {}),
  };
  const excluded = {
    closedDayBefore: story(alpha.id, 'day before', { finish_date: '2026-10-25T16:59:59Z' }),
    closedDayAfter: story(beta.id, 'day after', { finish_date: '2026-11-01T17:00:00Z', due_date: '2026-11-05' }),
    closedAndDueOutside: story(alpha.id, 'outside', { finish_date: '2026-10-01T03:00:00Z', due_date: '2026-10-02' }),
    closedWithoutClosingDayDueOutside: story(alpha.id, 'closed long ago', { is_closed: true, due_date: '2026-09-01' }),
    someoneElses: story(alpha.id, 'not mine', { assigned: [other], due_date: '2026-10-28' }),
  };
  Object.assign(fake.addTask({ project: beta.id, subject: 'task' }), { assigned_to: me, is_closed: true, finished_date: '2026-10-28T03:00:00Z' });
  Object.assign(fake.addIssue({ project: alpha.id, subject: 'issue' }), { assigned_to: me, is_closed: true, finished_date: '2026-10-30T08:00:00Z' });
  return { me, stranger, alpha, beta, tickets, excluded };
}

/** Today in `TZ`, as YYYY-MM-DD (`en-CA` formats dates that way). */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

test("tickets lists the period's tickets with their due status, in local days, without writing", async (t) => {
  const h = await startHarness(t);
  const { me, stranger, alpha, beta, tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.deepEqual(report.user, { id: me, username: 'taigent-bot' });
  assert.equal(report.project, null);
  assert.deepEqual(report.range, { from: '2026-10-26', to: '2026-11-01', start: '2026-10-25T17:00:00.000Z', end: '2026-11-01T17:00:00.000Z' });
  assert.equal(report.today, todayIn(TZ));
  assert.ok(!Number.isNaN(Date.parse(report.generatedAt)), report.generatedAt);
  assert.deepEqual(
    report.tickets.map(({ id, project, status, isClosed, dueDate, closedAt, dueStatus }) => ({ id, project: project.slug, status, isClosed, dueDate, closedAt, dueStatus })),
    [
      { id: tickets.dueInRangeClosedBefore.id, project: 'alpha', status: 'Done', isClosed: true, dueDate: '2026-10-28', closedAt: '2026-10-20T03:00:00Z', dueStatus: 'On time' },
      { id: tickets.closedFirstMinuteOnDueDay.id, project: 'alpha', status: 'Done', isClosed: true, dueDate: '2026-10-26', closedAt: '2026-10-25T17:00:00Z', dueStatus: 'On time' },
      { id: tickets.closedWithoutDueDate.id, project: 'alpha', status: 'Done', isClosed: true, dueDate: null, closedAt: '2026-10-28T00:00:00Z', dueStatus: 'No due date' },
      { id: tickets.closedLastMinuteLate.id, project: 'beta', status: 'Done', isClosed: true, dueDate: '2026-10-30', closedAt: '2026-11-01T16:59:00Z', dueStatus: 'Late' },
      { id: tickets.closedWithoutClosingDay.id, project: 'beta', status: 'Done', isClosed: true, dueDate: '2026-10-29', closedAt: null, dueStatus: null },
      { id: tickets.openOverdue.id, project: 'beta', status: 'In progress', isClosed: false, dueDate: '2000-01-03', closedAt: null, dueStatus: 'Overdue' },
      { id: tickets.openOnTrack.id, project: 'alpha', status: 'Ready for test', isClosed: false, dueDate: '2999-12-31', closedAt: null, dueStatus: 'On track' },
      { id: tickets.openNoDueDate.id, project: 'alpha', status: 'New', isClosed: false, dueDate: null, closedAt: null, dueStatus: 'No due date' },
    ],
  );
  const late = report.tickets.find((ticket) => ticket.id === tickets.closedLastMinuteLate.id)!;
  assert.deepEqual(late, {
    id: tickets.closedLastMinuteLate.id,
    ref: tickets.closedLastMinuteLate.ref,
    subject: 'last minute',
    status: 'Done',
    isClosed: true,
    project: { id: beta.id, slug: 'beta', name: 'Beta' },
    assignees: ['other', 'taigent-bot', stranger],
    dueDate: '2026-10-30',
    closedAt: '2026-11-01T16:59:00Z',
    dueStatus: 'Late',
  });
  assert.deepEqual(report.tickets.find((ticket) => ticket.project.id === alpha.id)!.assignees, ['taigent-bot']);
  assert.deepEqual(
    h.fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth'),
    [],
    'tickets only reads',
  );
});

test('tickets reads every story assigned to the user, beyond the first page', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'alpha' });
  const stories = Array.from({ length: 35 }, (_, i) =>
    Object.assign(h.fake.addUserStory({ project: project.id, subject: `open ${i}` }), { assigned_users: [h.fake.user.id] }),
  );

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.json<TicketsJson>().tickets.map(({ ref }) => ref).sort((a, b) => a - b),
    stories.map(({ ref }) => ref),
  );
});

test('tickets --project keeps the tickets of that project only', async (t) => {
  const h = await startHarness(t);
  const { tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--project', 'beta', '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.equal(report.project, 'beta');
  assert.deepEqual(
    report.tickets.map(({ id }) => id),
    [tickets.closedLastMinuteLate.id, tickets.closedWithoutClosingDay.id, tickets.openOverdue.id],
  );
});

test('tickets --project with an unknown slug is a Taiga error (exit 5)', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--project', 'nope', '--json'], { env: { TZ } });

  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /project "nope" not found/);
});

test('tickets prints a text report: the totals, then each project with one line per ticket', async (t) => {
  const h = await startHarness(t);
  const { tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^Tickets 2026-10-26 to 2026-11-01, assigned to taigent-bot: 8 /);
  assert.ok(lines.includes('alpha (Alpha): 5'), result.stdout);
  assert.ok(lines.includes('beta (Beta): 3'), result.stdout);
  assert.ok(
    lines.some((line) => line.includes(`#${tickets.closedLastMinuteLate.ref}`) && line.includes('Late') && line.includes('2026-11-01 23:59') && line.includes('last minute')),
    result.stdout,
  );
});

test('tickets without a valid day range is a usage error that never contacts Taiga (exit 2)', async (t) => {
  const h = await startHarness(t);

  for (const args of [
    ['tickets', '--from', '2026-10-26'],
    ['tickets', '--to', '2026-11-01'],
    ['tickets', '--from', '2026-02-30', '--to', '2026-03-01'],
    ['tickets', '--from', '26/10/2026', '--to', '2026-11-01'],
    ['tickets', '--from', '2026-11-02', '--to', '2026-11-01'],
    ['plan', '--project', 'alpha', ...RANGE],
    ['validate', ...RANGE],
  ]) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stderr}`);
  }
  assert.deepEqual(h.fake.requests, []);
});

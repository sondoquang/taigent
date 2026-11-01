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
  effort: number | null;
  effortSource: 'spent' | 'points' | null;
}

interface TicketsJson {
  user: { id: number; username: string };
  project: string | null;
  range: { from: string; to: string; start: string; end: string };
  today: string;
  generatedAt: string;
  tickets: TicketJson[];
  days: { date: string; closed: number; effort: number }[];
  summary: {
    tickets: number;
    closed: { total: number; byDueStatus: Record<string, number>; withoutClosingDay: number };
    open: { total: number; byDueStatus: Record<string, number> };
    effort: { hours: number; spent: { hours: number; tickets: number }; points: { hours: number; tickets: number } };
    projects: { slug: string; name: string; tickets: number }[];
  };
  notes: {
    bulkCloses: { count: number; first: string; last: string; tickets: { ref: number; project: string }[] }[];
    missingEffort: { ref: number; project: string }[];
  };
}

type StoryFields = Partial<Pick<FakeUserStory, 'is_closed' | 'finish_date' | 'due_date' | 'status_name' | 'total_points'>> & { assigned?: number[] };

/** Stories of the fake user (and of someone else) in two projects, plus a task that is not a ticket. */
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
    closedLastMinuteLate: story(beta.id, 'last minute', { finish_date: '2026-11-01T16:59:00Z', due_date: '2026-10-30', total_points: 3, assigned: [other, me, stranger] }),
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
  Object.assign(fake.addTask({ project: beta.id, subject: 'task' }), { assigned_to: me, is_closed: true });
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
    effort: 3,
    effortSource: 'points',
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

test('tickets gives each ticket its effort: Spent Time found by name per project, else total points', async (t) => {
  const h = await startHarness(t);
  const me = h.fake.user.id;
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me] });
  const beta = h.fake.addProject({ slug: 'beta', name: 'Beta', members: [me] });
  const gamma = h.fake.addProject({ slug: 'gamma', name: 'Gamma', members: [me] });
  const alphaSpent = h.fake.addCustomAttribute({ itemType: 'userstory', project: alpha.id, name: 'Spent Time', type: 'number' });
  const betaNotes = h.fake.addCustomAttribute({ itemType: 'userstory', project: beta.id, name: 'Notes' });
  const betaSpent = h.fake.addCustomAttribute({ itemType: 'userstory', project: beta.id, name: ' spent time ', type: 'number' });
  h.fake.addCustomAttribute({ itemType: 'task', project: gamma.id, name: 'Spent Time', type: 'number' });
  const story = (project: number, subject: string, fields: StoryFields, values?: Record<string, unknown>) => {
    const created = Object.assign(h.fake.addUserStory({ project, subject }), { assigned_users: [me], ...fields });
    if (values) h.fake.editAttributeValues('userstory', created.id, values);
    return created;
  };
  const spent = story(alpha.id, 'spent', { total_points: 8 }, { [alphaSpent.id]: 3.5 });
  const spentZero = story(alpha.id, 'spent zero', { total_points: 8 }, { [alphaSpent.id]: 0 });
  const spentEmpty = story(alpha.id, 'spent empty', { total_points: 5 });
  const missing = story(alpha.id, 'missing', {}, { [alphaSpent.id]: null });
  // Beta's Spent Time has another id: alpha's id in beta's values is not its Spent Time.
  const otherId = story(beta.id, 'other id', { total_points: 1 }, { [alphaSpent.id]: 99, [betaNotes.id]: 'n', [betaSpent.id]: 4 });
  const notANumber = story(beta.id, 'not a number', { total_points: 2.5 }, { [betaSpent.id]: 'two' });
  // Gamma has no user story attribute "Spent Time" (only a task one).
  const noAttribute = story(gamma.id, 'no attribute', { total_points: 2 });
  const noAttributeMissing = story(gamma.id, 'no attribute, no points', {});

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  const effort = (id: number) => {
    const ticket = report.tickets.find((ticket) => ticket.id === id)!;
    return [ticket.effort, ticket.effortSource];
  };
  assert.deepEqual(effort(spent.id), [3.5, 'spent']);
  assert.deepEqual(effort(spentZero.id), [0, 'spent']);
  assert.deepEqual(effort(spentEmpty.id), [5, 'points']);
  assert.deepEqual(effort(missing.id), [null, null]);
  assert.deepEqual(effort(otherId.id), [4, 'spent']);
  assert.deepEqual(effort(notANumber.id), [2.5, 'points']);
  assert.deepEqual(effort(noAttribute.id), [2, 'points']);
  assert.deepEqual(effort(noAttributeMissing.id), [null, null]);
  assert.deepEqual(
    [...report.notes.missingEffort].sort((a, b) => a.ref - b.ref),
    [
      { ref: missing.ref, project: 'alpha' },
      { ref: noAttributeMissing.ref, project: 'gamma' },
    ].sort((a, b) => a.ref - b.ref),
  );
  assert.ok(
    !h.fake.requests.some((r) => r.path.startsWith('/userstories/custom-attributes-values/') && [noAttribute.id, noAttributeMissing.id].some((id) => r.path.endsWith(`/${id}`))),
    'no values read where the project has no Spent Time',
  );

  const text = await h.taigent(['tickets', ...RANGE], { env: { TZ } });
  assert.equal(text.code, 0, text.stderr);
  const line = (subject: string) => text.stdout.split('\n').find((l) => l.endsWith(`  ${subject}`))!;
  assert.match(line('spent'), /  3\.5h  /);
  assert.match(line('spent empty'), /  5h \(estimated from points\)  /);
  assert.match(line('missing'), /  no effort  /);
});

test('tickets totals the period: every day with its closed tickets, the summary, and the text totals line', async (t) => {
  const h = await startHarness(t);
  const me = h.fake.user.id;
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me] });
  const beta = h.fake.addProject({ slug: 'beta', name: 'Beta', members: [me] });
  const spentTime = h.fake.addCustomAttribute({ itemType: 'userstory', project: alpha.id, name: 'Spent Time', type: 'number' });
  const story = (project: number, subject: string, fields: StoryFields, spent?: number) => {
    const created = Object.assign(h.fake.addUserStory({ project, subject }), { assigned_users: [me], is_closed: fields.finish_date != null, ...fields });
    if (spent !== undefined) h.fake.editAttributeValues('userstory', created.id, { [spentTime.id]: spent });
    return created;
  };
  story(alpha.id, 'on time', { finish_date: '2026-10-27T02:00:00Z', due_date: '2026-10-28', total_points: 9 }, 2);
  story(alpha.id, 'late', { finish_date: '2026-10-27T03:00:00Z', due_date: '2026-10-26', total_points: 3 });
  story(alpha.id, 'no due date, no effort', { finish_date: '2026-10-26T18:00:00Z' });
  story(beta.id, 'late, local next day', { finish_date: '2026-10-31T17:30:00Z', due_date: '2026-10-30', total_points: 1.5 });
  story(beta.id, 'closed before the period', { finish_date: '2026-10-15T03:00:00Z', due_date: '2026-10-29', total_points: 5 });
  story(beta.id, 'closed without closing day', { is_closed: true, due_date: '2026-10-29', total_points: 1 });
  story(alpha.id, 'overdue', { due_date: '2000-01-01' }, 4);
  story(beta.id, 'on track', { due_date: '2999-12-31', total_points: 2 });
  story(alpha.id, 'open', {});

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.deepEqual(report.days, [
    { date: '2026-10-26', closed: 0, effort: 0 },
    { date: '2026-10-27', closed: 3, effort: 5 },
    { date: '2026-10-28', closed: 0, effort: 0 },
    { date: '2026-10-29', closed: 0, effort: 0 },
    { date: '2026-10-30', closed: 0, effort: 0 },
    { date: '2026-10-31', closed: 0, effort: 0 },
    { date: '2026-11-01', closed: 1, effort: 1.5 },
  ]);
  assert.deepEqual(report.summary, {
    tickets: 9,
    closed: { total: 6, byDueStatus: { 'On time': 2, Late: 2, 'No due date': 1 }, withoutClosingDay: 1 },
    open: { total: 3, byDueStatus: { Overdue: 1, 'On track': 1, 'No due date': 1 } },
    effort: { hours: 18.5, spent: { hours: 6, tickets: 2 }, points: { hours: 12.5, tickets: 5 } },
    projects: [
      { slug: 'alpha', name: 'Alpha', tickets: 5 },
      { slug: 'beta', name: 'Beta', tickets: 4 },
    ],
  });

  const text = await h.taigent(['tickets', ...RANGE], { env: { TZ } });
  assert.equal(text.code, 0, text.stderr);
  assert.equal(
    text.stdout.split('\n')[0],
    'Tickets 2026-10-26 to 2026-11-01, assigned to taigent-bot: 9 (closed 6: On time 2, Late 2, No due date 1, without a closing day 1; open 3: Overdue 1, On track 1, No due date 1), effort 18.5h (Spent Time 2 tickets, points 5 tickets)',
  );
});

test('tickets notes bulk closes: 3 or more tickets each closed within 60 seconds of the previous one', async (t) => {
  const h = await startHarness(t);
  const me = h.fake.user.id;
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me] });
  const closedAt = (seconds: number) => new Date(Date.parse('2026-11-01T02:00:00Z') + seconds * 1000).toISOString();
  const story = (subject: string, fields: StoryFields) =>
    Object.assign(h.fake.addUserStory({ project: alpha.id, subject }), { assigned_users: [me], is_closed: fields.finish_date != null, ...fields });
  // Added out of order: the groups follow the closing time.
  const second = [170, 161, 200].map((s) => story(`second ${s}`, { finish_date: closedAt(s) }));
  const first = [0, 30, 90, 100].map((s) => story(`first ${s}`, { finish_date: closedAt(s) }));
  story('pair 1', { finish_date: closedAt(1000) });
  story('pair 2', { finish_date: closedAt(1010) });
  story('alone', { finish_date: '2026-10-28T02:00:00Z' });
  story('closed without closing day', { is_closed: true, due_date: '2026-10-29' });
  story('open', {});

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<TicketsJson>().notes.bulkCloses, [
    { count: 4, first: closedAt(0), last: closedAt(100), tickets: first.map(({ ref }) => ({ ref, project: 'alpha' })) },
    { count: 3, first: closedAt(161), last: closedAt(200), tickets: [second[1]!, second[0]!, second[2]!].map(({ ref }) => ({ ref, project: 'alpha' })) },
  ]);
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

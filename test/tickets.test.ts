import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness } from './support/harness.ts';

// UTC+7 without daylight saving: the days 2026-11-16..2026-11-22 run from 2026-11-15T17:00Z to 2026-11-22T17:00Z.
const TZ = 'Asia/Ho_Chi_Minh';
const RANGE = ['--from', '2026-11-16', '--to', '2026-11-22'];
// Thursday 2026-11-19, 10:00 local time.
const NOW = '2026-11-19T03:00:00.000Z';
const ENV = { TZ, TAIGENT_NOW: NOW };

interface TicketJson {
  id: number;
  ref: number;
  subject: string;
  status: string;
  progress: string;
  isFinished: boolean;
  project: { id: number; slug: string; name: string };
  assignees: (string | number)[];
  dueDate: string | null;
  closedAt: string | null;
  finishedAt: string | null;
  dueStatus: string | null;
  effort: number | null;
  effortSource: 'spent' | 'points' | null;
  points: number | null;
  spentTime: number | null;
  remainingWork: number | null;
  latestStartDay: string | null;
  plannedFinishDay: string | null;
  atRisk: boolean;
  sharingTickets: TicketIdJson[];
}

interface TicketIdJson {
  ref: number;
  project: string;
}

/** How the report names a story: its ref and its project's slug. */
const id = (story: FakeUserStory, project = 'alpha'): TicketIdJson => ({ ref: story.ref, project });

interface TicketsJson {
  user: { id: number; username: string };
  project: string | null;
  range: { from: string; to: string; start: string; end: string };
  today: string;
  generatedAt: string;
  tickets: TicketJson[];
  days: { date: string; finished: number; effort: number }[];
  summary: {
    tickets: number;
    byProgress: Record<string, number>;
    finished: { total: number; byDueStatus: Record<string, number>; withoutFinishingDay: number };
    notFinished: { total: number; byDueStatus: Record<string, number> };
    effort: { hours: number; spent: { hours: number; tickets: number }; points: { hours: number; tickets: number } };
    projects: { slug: string; name: string; tickets: number }[];
  };
  plan: { start: string; days: { date: string; hours: number; entries: (TicketIdJson & { hours: number })[] }[] };
  warnings: Record<'overdue' | 'noDueDate' | 'noPoints' | 'lateStart' | 'atRisk', TicketIdJson[]>;
  replan: (TicketIdJson & { id: number; subject: string; dueDate: string; proposedDueDate: string; sharingTickets: TicketIdJson[]; comment: string })[];
  notes: {
    bulkCloses: { count: number; first: string; last: string; tickets: TicketIdJson[] }[];
    missingEffort: TicketIdJson[];
  };
}

type StoryFields = Partial<Pick<FakeUserStory, 'is_closed' | 'finish_date' | 'due_date' | 'status_name' | 'total_points'>> & { assigned?: number[] };

/** A story of `project` assigned to the fake user (or `assigned`); a `finish_date` closes it (in Done unless `status_name` says otherwise). */
function addStory(fake: FakeTaiga, project: number, subject: string, { assigned = [fake.user.id], ...fields }: StoryFields): FakeUserStory {
  return Object.assign(fake.addUserStory({ project, subject }), { assigned_users: assigned, is_closed: fields.finish_date != null, ...fields });
}

/** Stories of the fake user (and of someone else) in two projects, in every status, plus a task that is not a ticket. */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const stranger = fake.addUser({ username: 'stranger' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other] });
  const beta = fake.addProject({ slug: 'beta', name: 'Beta', members: [me, other] });
  const story = (project: number, subject: string, fields: StoryFields) => addStory(fake, project, subject, fields);
  const tickets = {
    readyOverdue: story(alpha.id, 'overdue', { status_name: 'Ready', due_date: '2026-11-18', total_points: 2 }),
    readyOnTrack: story(beta.id, 'on track', { status_name: 'Ready', due_date: '2026-11-20', total_points: 5 }),
    readyDueLater: story(alpha.id, 'due after the period', { status_name: 'Ready', due_date: '2026-12-31' }),
    inProgressDueToday: story(beta.id, 'due today', { status_name: 'In progress', due_date: '2026-11-19', total_points: 3, assigned: [other, me, stranger] }),
    inProgressNoDueDate: story(alpha.id, 'no due date', { status_name: 'In progress' }),
    readyForTestOnTime: story(alpha.id, 'waiting for QA', { status_name: 'Ready for test', due_date: '2026-11-18', total_points: 1 }),
    doneLate: story(beta.id, 'done late', { finish_date: '2026-11-18T10:00:00Z', due_date: '2026-11-17', total_points: 8 }),
    doneFirstMinute: story(alpha.id, 'first minute', { finish_date: '2026-11-15T17:00:00Z', due_date: '2026-11-16' }),
    doneNoDueDate: story(alpha.id, 'done, no due date', { finish_date: '2026-11-19T01:00:00Z' }),
  };
  fake.addStatusChange(tickets.readyForTestOnTime, { at: '2026-11-18T05:00:00Z', from: 'In progress', to: 'Ready for test' });
  const excluded = {
    inNew: story(alpha.id, 'not planned yet', { due_date: '2026-11-19' }),
    archived: story(alpha.id, 'abandoned', { status_name: 'Archived', finish_date: '2026-11-17T03:00:00Z', due_date: '2026-11-18' }),
    doneDayBefore: story(alpha.id, 'done the day before', { finish_date: '2026-11-15T16:59:59Z', due_date: '2026-11-18' }),
    doneDayAfter: story(beta.id, 'done the day after', { finish_date: '2026-11-22T17:00:00Z' }),
    doneWithoutClosingDay: story(beta.id, 'done, no closing day', { is_closed: true, due_date: '2026-11-18' }),
    someoneElses: story(alpha.id, 'not mine', { status_name: 'In progress', assigned: [other], due_date: '2026-11-19' }),
  };
  Object.assign(fake.addTask({ project: beta.id, subject: 'task' }), { assigned_to: me, is_closed: false });
  return { me, stranger, alpha, beta, tickets, excluded };
}

test("tickets lists your planned tickets and those done in the period, by progress group with their due status, without writing", async (t) => {
  const h = await startHarness(t);
  const { me, stranger, beta, tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.deepEqual(report.user, { id: me, username: 'taigent-bot' });
  assert.equal(report.project, null);
  assert.deepEqual(report.range, { from: '2026-11-16', to: '2026-11-22', start: '2026-11-15T17:00:00.000Z', end: '2026-11-22T17:00:00.000Z' });
  assert.equal(report.today, '2026-11-19');
  assert.equal(report.generatedAt, NOW);
  assert.deepEqual(
    report.tickets.map(({ id, project, progress, isFinished, dueDate, finishedAt, dueStatus }) => ({ id, project: project.slug, progress, isFinished, dueDate, finishedAt, dueStatus })),
    [
      { id: tickets.readyOverdue.id, project: 'alpha', progress: 'Ready', isFinished: false, dueDate: '2026-11-18', finishedAt: null, dueStatus: 'Overdue' },
      { id: tickets.readyOnTrack.id, project: 'beta', progress: 'Ready', isFinished: false, dueDate: '2026-11-20', finishedAt: null, dueStatus: 'On track' },
      { id: tickets.readyDueLater.id, project: 'alpha', progress: 'Ready', isFinished: false, dueDate: '2026-12-31', finishedAt: null, dueStatus: 'On track' },
      { id: tickets.inProgressDueToday.id, project: 'beta', progress: 'In progress', isFinished: false, dueDate: '2026-11-19', finishedAt: null, dueStatus: 'Due today' },
      { id: tickets.inProgressNoDueDate.id, project: 'alpha', progress: 'In progress', isFinished: false, dueDate: null, finishedAt: null, dueStatus: 'No due date' },
      { id: tickets.readyForTestOnTime.id, project: 'alpha', progress: 'Ready for test', isFinished: true, dueDate: '2026-11-18', finishedAt: '2026-11-18T05:00:00Z', dueStatus: 'On time' },
      { id: tickets.doneFirstMinute.id, project: 'alpha', progress: 'Done', isFinished: true, dueDate: '2026-11-16', finishedAt: '2026-11-15T17:00:00Z', dueStatus: 'On time' },
      { id: tickets.doneLate.id, project: 'beta', progress: 'Done', isFinished: true, dueDate: '2026-11-17', finishedAt: '2026-11-18T10:00:00Z', dueStatus: 'Late' },
      { id: tickets.doneNoDueDate.id, project: 'alpha', progress: 'Done', isFinished: true, dueDate: null, finishedAt: '2026-11-19T01:00:00Z', dueStatus: 'No due date' },
    ],
  );
  assert.deepEqual(report.tickets.find((ticket) => ticket.id === tickets.inProgressDueToday.id), {
    id: tickets.inProgressDueToday.id,
    ref: tickets.inProgressDueToday.ref,
    subject: 'due today',
    status: 'In progress',
    progress: 'In progress',
    isFinished: false,
    project: { id: beta.id, slug: 'beta', name: 'Beta' },
    assignees: ['other', 'taigent-bot', stranger],
    dueDate: '2026-11-19',
    closedAt: null,
    finishedAt: null,
    dueStatus: 'Due today',
    effort: 3,
    effortSource: 'points',
    points: 3,
    spentTime: null,
    remainingWork: 3,
    latestStartDay: '2026-11-19',
    plannedFinishDay: '2026-11-19',
    atRisk: false,
    sharingTickets: [id(tickets.readyOverdue), id(tickets.readyOnTrack, 'beta')],
  });
  assert.equal(report.tickets.find((ticket) => ticket.id === tickets.doneLate.id)!.closedAt, '2026-11-18T10:00:00Z');
  assert.deepEqual(
    h.fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth'),
    [],
    'tickets only reads',
  );
});

test('tickets takes the finishing day from the story history: the last move into Ready for test or Done from a status not finished', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const story = (subject: string, fields: StoryFields) => addStory(h.fake, alpha.id, subject, fields);
  const returned = story('returned by QA, finished again', { status_name: 'Ready for test', due_date: '2026-11-18' });
  h.fake.addStatusChange(returned, { at: '2026-11-17T03:00:00Z', from: 'In progress', to: 'Ready for test' });
  h.fake.addStatusChange(returned, { at: '2026-11-18T03:00:00Z', from: 'Ready for test', to: 'In progress' });
  h.fake.addStatusChange(returned, { at: '2026-11-19T02:00:00Z', from: 'In progress', to: 'Ready for test' });
  const doneAfterTest = story('tested, then done', { finish_date: '2026-11-19T02:30:00Z', due_date: '2026-11-18' });
  h.fake.addStatusChange(doneAfterTest, { at: '2026-11-17T09:00:00Z', from: 'In progress', to: 'Ready for test' });
  h.fake.addStatusChange(doneAfterTest, { at: '2026-11-19T02:30:00Z', from: 'Ready for test', to: 'Done' });
  const doneWithoutHistory = story('done, no history', { finish_date: '2026-11-17T10:00:00Z', due_date: '2026-11-17' });
  const readyForTestWithoutHistory = story('waiting for QA, no history', { status_name: 'Ready for test', due_date: '2026-11-18' });
  const readyForTestNoDueDate = story('waiting for QA, no due date', { status_name: 'Ready for test' });
  const inProgress = story('in progress', { status_name: 'In progress', due_date: '2026-11-20' });
  h.fake.addStatusChange(inProgress, { at: '2026-11-17T03:00:00Z', from: 'In progress', to: 'Ready for test' });
  h.fake.addStatusChange(inProgress, { at: '2026-11-18T03:00:00Z', from: 'Ready for test', to: 'In progress' });

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  const finishing = (id: number) => {
    const { isFinished, finishedAt, dueStatus } = report.tickets.find((ticket) => ticket.id === id)!;
    return { isFinished, finishedAt, dueStatus };
  };
  assert.deepEqual(finishing(returned.id), { isFinished: true, finishedAt: '2026-11-19T02:00:00Z', dueStatus: 'Late' });
  assert.deepEqual(finishing(doneAfterTest.id), { isFinished: true, finishedAt: '2026-11-17T09:00:00Z', dueStatus: 'On time' });
  assert.deepEqual(finishing(doneWithoutHistory.id), { isFinished: true, finishedAt: '2026-11-17T10:00:00Z', dueStatus: 'On time' });
  assert.deepEqual(finishing(readyForTestWithoutHistory.id), { isFinished: true, finishedAt: null, dueStatus: null });
  assert.deepEqual(finishing(readyForTestNoDueDate.id), { isFinished: true, finishedAt: null, dueStatus: 'No due date' });
  assert.deepEqual(finishing(inProgress.id), { isFinished: false, finishedAt: null, dueStatus: 'On track' });
  assert.deepEqual(report.summary.finished, { total: 5, byDueStatus: { 'On time': 2, Late: 1, 'No due date': 1 }, withoutFinishingDay: 1 });
  const historyReads = h.fake.requests.filter((r) => r.path.startsWith('/history/userstory/')).map((r) => Number(r.path.split('/').at(-1)));
  assert.deepEqual(
    historyReads.sort((a, b) => a - b),
    [returned.id, doneAfterTest.id, doneWithoutHistory.id, readyForTestWithoutHistory.id, readyForTestNoDueDate.id].sort((a, b) => a - b),
    'only finished tickets have their history read',
  );
});

test('tickets totals the period: tickets finished per finishing day, the summary by progress group and due status, and the text report', async (t) => {
  const h = await startHarness(t);
  const { tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.deepEqual(report.days, [
    { date: '2026-11-16', finished: 1, effort: 0 },
    { date: '2026-11-17', finished: 0, effort: 0 },
    { date: '2026-11-18', finished: 2, effort: 9 },
    { date: '2026-11-19', finished: 1, effort: 0 },
    { date: '2026-11-20', finished: 0, effort: 0 },
    { date: '2026-11-21', finished: 0, effort: 0 },
    { date: '2026-11-22', finished: 0, effort: 0 },
  ]);
  assert.deepEqual(report.summary, {
    tickets: 9,
    byProgress: { Ready: 3, 'In progress': 2, 'Ready for test': 1, Done: 3 },
    finished: { total: 4, byDueStatus: { 'On time': 2, Late: 1, 'No due date': 1 }, withoutFinishingDay: 0 },
    notFinished: { total: 5, byDueStatus: { Overdue: 1, 'Due today': 1, 'On track': 2, 'No due date': 1 } },
    effort: { hours: 19, spent: { hours: 0, tickets: 0 }, points: { hours: 19, tickets: 5 } },
    projects: [
      { slug: 'alpha', name: 'Alpha', tickets: 6 },
      { slug: 'beta', name: 'Beta', tickets: 3 },
    ],
  });
  assert.deepEqual(
    report.notes.missingEffort,
    [tickets.readyDueLater, tickets.inProgressNoDueDate, tickets.doneFirstMinute, tickets.doneNoDueDate].map(({ ref }) => ({ ref, project: 'alpha' })),
  );

  const text = await h.taigent(['tickets', ...RANGE], { env: ENV });
  assert.equal(text.code, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    'Tickets 2026-11-16 to 2026-11-22, assigned to taigent-bot, today 2026-11-19: 9, effort 19h (Spent Time 0 tickets, points 5 tickets)',
    'Progress: Ready 3, In progress 2, Ready for test 1, Done 3',
    'Not finished 5: Overdue 1, Due today 1, On track 2, No due date 1',
    'Finished 4: On time 2, Late 1, No due date 1',
  ]);
  assert.ok(lines.includes('alpha (Alpha): 6'), text.stdout);
  assert.ok(lines.includes('beta (Beta): 3'), text.stdout);
  assert.ok(
    lines.includes(
      `  #${tickets.inProgressDueToday.ref}  In progress  Due today  due 2026-11-19  not finished  3h (estimated from points)  remaining 3h, start by 2026-11-19, planned finish 2026-11-19  due today`,
    ),
    text.stdout,
  );
  assert.ok(lines.includes(`  #${tickets.doneLate.ref}  Done  Late  due 2026-11-17  finished 2026-11-18 17:00  8h (estimated from points)  done late`), text.stdout);
});

test('tickets reads every story assigned to the user, beyond the first page', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'alpha' });
  const stories = Array.from({ length: 35 }, (_, i) => addStory(h.fake, project.id, `ready ${i}`, { status_name: 'Ready' }));

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.json<TicketsJson>().tickets.map(({ ref }) => ref),
    stories.map(({ ref }) => ref),
  );
});

test('tickets --project keeps the tickets of that project only', async (t) => {
  const h = await startHarness(t);
  const { tickets } = seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--project', 'beta', '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.equal(report.project, 'beta');
  assert.deepEqual(
    report.tickets.map(({ id }) => id),
    [tickets.readyOnTrack.id, tickets.inProgressDueToday.id, tickets.doneLate.id],
  );
  assert.deepEqual(report.plan, {
    start: '2026-11-19',
    days: [{ date: '2026-11-19', hours: 8, entries: [{ ...id(tickets.inProgressDueToday, 'beta'), hours: 3 }, { ...id(tickets.readyOnTrack, 'beta'), hours: 5 }] }],
  });
  const text = await h.taigent(['tickets', ...RANGE, '--project', 'beta'], { env: ENV });
  assert.match(text.stdout, /^Tickets 2026-11-16 to 2026-11-22 in beta, assigned to taigent-bot, today 2026-11-19: 3, /);
});

test('tickets --project with an unknown slug is a Taiga error (exit 5)', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);

  const result = await h.taigent(['tickets', ...RANGE, '--project', 'nope', '--json'], { env: ENV });

  assert.equal(result.code, 5, result.stderr);
  assert.match(result.stderr, /project "nope" not found/);
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
    const created = addStory(h.fake, project, subject, { status_name: 'In progress', ...fields });
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

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

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

  const text = await h.taigent(['tickets', ...RANGE], { env: ENV });
  assert.equal(text.code, 0, text.stderr);
  const line = (subject: string) => text.stdout.split('\n').find((l) => l.endsWith(`  ${subject}`))!;
  assert.match(line('spent'), /  3\.5h  /);
  assert.match(line('spent empty'), /  5h \(estimated from points\)  /);
  assert.match(line('missing'), /  no effort  /);
});

test('tickets notes bulk closes: 3 or more tickets each closed within 60 seconds of the previous one', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const closedAt = (seconds: number) => new Date(Date.parse('2026-11-18T02:00:00Z') + seconds * 1000).toISOString();
  const story = (subject: string, fields: StoryFields) => addStory(h.fake, alpha.id, subject, fields);
  // Added out of order: the groups follow the closing time.
  const second = [170, 161, 200].map((s) => story(`second ${s}`, { finish_date: closedAt(s) }));
  const first = [0, 30, 90, 100].map((s) => story(`first ${s}`, { finish_date: closedAt(s) }));
  story('pair 1', { finish_date: closedAt(1000) });
  story('pair 2', { finish_date: closedAt(1010) });
  story('alone', { finish_date: '2026-11-17T02:00:00Z' });
  story('waiting for QA', { status_name: 'Ready for test' });
  story('ready', { status_name: 'Ready' });

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.json<TicketsJson>().notes.bulkCloses, [
    { count: 4, first: closedAt(0), last: closedAt(100), tickets: first.map(({ ref }) => ({ ref, project: 'alpha' })) },
    { count: 3, first: closedAt(161), last: closedAt(200), tickets: [second[1]!, second[0]!, second[2]!].map(({ ref }) => ({ ref, project: 'alpha' })) },
  ]);
});

test('tickets without a valid day range or TAIGENT_NOW is a usage error that never contacts Taiga (exit 2)', async (t) => {
  const h = await startHarness(t);

  for (const args of [
    ['tickets', '--from', '2026-11-16'],
    ['tickets', '--to', '2026-11-22'],
    ['tickets', '--from', '2026-02-30', '--to', '2026-03-01'],
    ['tickets', '--from', '16/11/2026', '--to', '2026-11-22'],
    ['tickets', '--from', '2026-11-23', '--to', '2026-11-22'],
    ['plan', '--project', 'alpha', ...RANGE],
    ['validate', ...RANGE],
  ]) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.stderr}`);
  }
  for (const now of ['2026-11-19', '2026-11-19T10:00:00', 'tomorrow', '2026-13-19T10:00:00Z']) {
    const result = await h.taigent(['tickets', ...RANGE], { env: { TZ, TAIGENT_NOW: now } });
    assert.equal(result.code, 2, `TAIGENT_NOW=${now}\n${result.stderr}`);
    assert.match(result.stderr, /TAIGENT_NOW must be an ISO 8601 instant with an offset/);
  }
  assert.deepEqual(h.fake.requests, []);
});

test('TAIGENT_NOW with an offset sets today in the local time zone', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', members: [h.fake.user.id] });
  const story = addStory(h.fake, alpha.id, 'due on the 20th', { status_name: 'Ready', due_date: '2026-11-20' });

  // 2026-11-19 23:30 in UTC+0 is already 2026-11-20 06:30 in UTC+7.
  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ, TAIGENT_NOW: '2026-11-19T23:30:00+00:00' } });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.equal(report.today, '2026-11-20');
  assert.equal(report.generatedAt, '2026-11-19T23:30:00.000Z');
  assert.equal(report.tickets.find((ticket) => ticket.id === story.id)!.dueStatus, 'Due today');
});

test('tickets gives each ticket not finished its remaining work, points less Spent Time, never below zero; tickets without a due date or points stay out of the plan as warnings', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const spentTime = h.fake.addCustomAttribute({ itemType: 'userstory', project: alpha.id, name: 'Spent Time', type: 'number' });
  const story = (subject: string, fields: StoryFields, spent?: number) => {
    const created = addStory(h.fake, alpha.id, subject, fields);
    if (spent !== undefined) h.fake.editAttributeValues('userstory', created.id, { [spentTime.id]: spent });
    return created;
  };
  const halfDone = story('half done', { status_name: 'In progress', due_date: '2026-11-20', total_points: 8 }, 3);
  const overSpent = story('over spent', { status_name: 'In progress', due_date: '2026-11-20', total_points: 2 }, 5);
  const notStarted = story('not started', { status_name: 'Ready', due_date: '2026-11-23', total_points: 4 });
  const noDueDate = story('no due date', { status_name: 'Ready', total_points: 3 });
  const noPoints = story('no points', { status_name: 'Ready', due_date: '2026-11-20' }, 2);
  const neither = story('neither', { status_name: 'In progress' });
  const finished = story('waiting for QA', { status_name: 'Ready for test', due_date: '2026-11-20', total_points: 5 }, 1);

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  const work = (story: FakeUserStory) => {
    const { points, spentTime, remainingWork, plannedFinishDay } = report.tickets.find((ticket) => ticket.id === story.id)!;
    return { points, spentTime, remainingWork, plannedFinishDay };
  };
  assert.deepEqual(work(halfDone), { points: 8, spentTime: 3, remainingWork: 5, plannedFinishDay: '2026-11-19' });
  assert.deepEqual(work(overSpent), { points: 2, spentTime: 5, remainingWork: 0, plannedFinishDay: '2026-11-19' });
  assert.deepEqual(work(notStarted), { points: 4, spentTime: null, remainingWork: 4, plannedFinishDay: '2026-11-20' });
  assert.deepEqual(work(noDueDate), { points: 3, spentTime: null, remainingWork: 3, plannedFinishDay: null });
  assert.deepEqual(work(noPoints), { points: null, spentTime: 2, remainingWork: null, plannedFinishDay: null });
  assert.deepEqual(work(neither), { points: null, spentTime: null, remainingWork: null, plannedFinishDay: null });
  assert.deepEqual(work(finished), { points: 5, spentTime: 1, remainingWork: null, plannedFinishDay: null });
  assert.deepEqual(report.plan, {
    start: '2026-11-19',
    days: [
      { date: '2026-11-19', hours: 8, entries: [{ ...id(halfDone), hours: 5 }, { ...id(notStarted), hours: 3 }] },
      { date: '2026-11-20', hours: 1, entries: [{ ...id(notStarted), hours: 1 }] },
    ],
  });
  assert.deepEqual(report.warnings.noDueDate, [id(noDueDate), id(neither)]);
  assert.deepEqual(report.warnings.noPoints, [id(noPoints), id(neither)]);
});

test('tickets plans by due date, In progress first on the same date, splitting tickets over working days from today, or from the next working day after 17:00 and on weekends', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const story = (subject: string, fields: StoryFields) => addStory(h.fake, alpha.id, subject, fields);
  const later = story('due later', { status_name: 'Ready', due_date: '2026-11-25', total_points: 8 });
  const ready = story('ready', { status_name: 'Ready', due_date: '2026-11-24', total_points: 6 });
  const inProgress = story('in progress', { status_name: 'In progress', due_date: '2026-11-24', total_points: 6 });
  const planAt = async (now: string) => {
    const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: { TZ, TAIGENT_NOW: now } });
    assert.equal(result.code, 0, result.stderr);
    return result.json<TicketsJson>().plan;
  };

  // Thursday 16:59: today still counts, and Friday's leftover goes on to Monday.
  assert.deepEqual(await planAt('2026-11-19T16:59:00+07:00'), {
    start: '2026-11-19',
    days: [
      { date: '2026-11-19', hours: 8, entries: [{ ...id(inProgress), hours: 6 }, { ...id(ready), hours: 2 }] },
      { date: '2026-11-20', hours: 8, entries: [{ ...id(ready), hours: 4 }, { ...id(later), hours: 4 }] },
      { date: '2026-11-23', hours: 4, entries: [{ ...id(later), hours: 4 }] },
    ],
  });
  // Thursday 17:00: the plan starts on Friday.
  assert.deepEqual((await planAt('2026-11-19T17:00:00+07:00')).days.map(({ date, hours }) => [date, hours]), [
    ['2026-11-20', 8],
    ['2026-11-23', 8],
    ['2026-11-24', 4],
  ]);
  // Friday evening, Saturday and Sunday: the plan starts on Monday.
  for (const now of ['2026-11-20T18:00:00+07:00', '2026-11-21T10:00:00+07:00', '2026-11-22T08:00:00+07:00']) {
    assert.equal((await planAt(now)).start, '2026-11-23', now);
  }
});

test('tickets gives each planned ticket its latest start day, counted back from its due date, and warns of a Ready ticket on or after it', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const story = (subject: string, fields: StoryFields) => addStory(h.fake, alpha.id, subject, fields);
  const tenPoints = story('10 points due Friday', { status_name: 'Ready', due_date: '2026-11-20', total_points: 10 });
  const dueMonday = story('9 points due Monday', { status_name: 'Ready', due_date: '2026-11-23', total_points: 9 });
  const dueSunday = story('due Sunday', { status_name: 'Ready', due_date: '2026-11-22', total_points: 4 });
  const started = story('started', { status_name: 'In progress', due_date: '2026-11-20', total_points: 16 });
  const overdue = story('overdue', { status_name: 'Ready', due_date: '2026-11-18', total_points: 1 });

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  const latestStart = (story: FakeUserStory) => report.tickets.find((ticket) => ticket.id === story.id)!.latestStartDay;
  assert.equal(latestStart(tenPoints), '2026-11-19');
  assert.equal(latestStart(dueMonday), '2026-11-20');
  assert.equal(latestStart(dueSunday), '2026-11-20');
  assert.equal(latestStart(started), '2026-11-19');
  assert.equal(latestStart(overdue), '2026-11-18');
  assert.deepEqual(report.warnings.lateStart, [id(overdue), id(tenPoints)]);
  assert.deepEqual(report.warnings.overdue, [id(overdue)]);
});

test('tickets flags a ticket At risk when the plan finishes it after its due date, with the tickets sharing its days and a re-plan entry; an Overdue ticket too', async (t) => {
  const h = await startHarness(t);
  const me = h.fake.user.id;
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me] });
  const beta = h.fake.addProject({ slug: 'beta', name: 'Beta', members: [me] });
  const overdue = addStory(h.fake, alpha.id, 'overdue', { status_name: 'In progress', due_date: '2026-11-18', total_points: 4 });
  const small = addStory(h.fake, alpha.id, 'small', { status_name: 'Ready', due_date: '2026-11-20', total_points: 5 });
  const safe = addStory(h.fake, alpha.id, 'safe', { status_name: 'Ready', due_date: '2026-11-27', total_points: 2 });
  const big = addStory(h.fake, beta.id, 'big', { status_name: 'Ready', due_date: '2026-11-20', total_points: 10 });
  assert.ok(big.ref < small.ref, 'big is planned before small on their shared due date');

  const result = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<TicketsJson>();
  assert.deepEqual(report.plan.days, [
    { date: '2026-11-19', hours: 8, entries: [{ ...id(overdue), hours: 4 }, { ...id(big, 'beta'), hours: 4 }] },
    { date: '2026-11-20', hours: 8, entries: [{ ...id(big, 'beta'), hours: 6 }, { ...id(small), hours: 2 }] },
    { date: '2026-11-23', hours: 5, entries: [{ ...id(small), hours: 3 }, { ...id(safe), hours: 2 }] },
  ]);
  const risk = (story: FakeUserStory) => {
    const { plannedFinishDay, atRisk, sharingTickets } = report.tickets.find((ticket) => ticket.id === story.id)!;
    return { plannedFinishDay, atRisk, sharingTickets };
  };
  assert.deepEqual(risk(overdue), { plannedFinishDay: '2026-11-19', atRisk: true, sharingTickets: [id(big, 'beta')] });
  assert.deepEqual(risk(big), { plannedFinishDay: '2026-11-20', atRisk: false, sharingTickets: [id(overdue), id(small)] });
  assert.deepEqual(risk(small), { plannedFinishDay: '2026-11-23', atRisk: true, sharingTickets: [id(big, 'beta'), id(safe)] });
  assert.deepEqual(risk(safe), { plannedFinishDay: '2026-11-23', atRisk: false, sharingTickets: [id(small)] });
  assert.deepEqual(report.warnings.atRisk, [id(small), id(overdue)]);
  assert.deepEqual(report.warnings.overdue, [id(overdue)]);
  assert.deepEqual(report.warnings.lateStart, [id(big, 'beta')]);
  assert.deepEqual(report.replan, [
    {
      ...id(small),
      id: small.id,
      subject: 'small',
      dueDate: '2026-11-20',
      proposedDueDate: '2026-11-23',
      sharingTickets: [id(big, 'beta'), id(safe)],
      comment:
        'Dời hạn từ 20/11/2026 sang 23/11/2026: còn 5h việc, xếp 8h mỗi ngày làm việc theo thứ tự hạn thì xong ngày 23/11/2026.' +
        ` Trùng ngày với beta#${big.ref}, #${safe.ref}.`,
    },
    {
      ...id(overdue),
      id: overdue.id,
      subject: 'overdue',
      dueDate: '2026-11-18',
      proposedDueDate: '2026-11-19',
      sharingTickets: [id(big, 'beta')],
      comment:
        'Dời hạn từ 18/11/2026 sang 19/11/2026: đã quá hạn, còn 4h việc, xếp 8h mỗi ngày làm việc theo thứ tự hạn thì xong ngày 19/11/2026.' +
        ` Trùng ngày với beta#${big.ref}.`,
    },
  ]);
  assert.deepEqual(
    h.fake.requests.filter((r) => r.method !== 'GET' && r.path !== '/auth'),
    [],
    'the re-plan writes nothing',
  );

  const text = await h.taigent(['tickets', ...RANGE], { env: ENV });
  assert.equal(text.code, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  const from = (heading: string, count: number) => lines.slice(lines.indexOf(heading), lines.indexOf(heading) + count);
  assert.deepEqual(from('Plan from 2026-11-19, 8h per working day:', 4), [
    'Plan from 2026-11-19, 8h per working day:',
    `  2026-11-19 Thu  8h: alpha#${overdue.ref} 4h, beta#${big.ref} 4h`,
    `  2026-11-20 Fri  8h: beta#${big.ref} 6h, alpha#${small.ref} 2h`,
    `  2026-11-23 Mon  5h: alpha#${small.ref} 3h, alpha#${safe.ref} 2h`,
  ]);
  assert.deepEqual(from('Warnings:', 4), [
    'Warnings:',
    `  Overdue: alpha#${overdue.ref}`,
    `  Late start: beta#${big.ref}`,
    `  At risk: alpha#${small.ref} (shares its days with beta#${big.ref}, alpha#${safe.ref}), alpha#${overdue.ref} (shares its days with beta#${big.ref})`,
  ]);
  assert.deepEqual(from('Re-plan, written to Taiga only once approved:', 3), [
    'Re-plan, written to Taiga only once approved:',
    `  alpha#${small.ref} due 2026-11-20 -> 2026-11-23: ${report.replan[0]!.comment}`,
    `  alpha#${overdue.ref} due 2026-11-18 -> 2026-11-19: ${report.replan[1]!.comment}`,
  ]);
  assert.ok(lines.includes(`  #${small.ref}  Ready  On track  due 2026-11-20  not finished  5h (estimated from points)  remaining 5h, start by 2026-11-20, planned finish 2026-11-23 (at risk)  small`), text.stdout);
});

test('tickets --eod plans from the next working day, as the end-of-day reminder does, so a ticket due today is At risk with its re-plan', async (t) => {
  const h = await startHarness(t);
  const alpha = h.fake.addProject({ slug: 'alpha', name: 'Alpha', members: [h.fake.user.id] });
  const dueToday = addStory(h.fake, alpha.id, 'due today', { status_name: 'In progress', due_date: '2026-11-19', total_points: 3 });

  const eod = await h.taigent(['tickets', ...RANGE, '--eod', '--json'], { env: ENV });
  const plain = await h.taigent(['tickets', ...RANGE, '--json'], { env: ENV });
  const misuse = await h.taigent(['notify', 'day', '--eod', '--dry-run'], { env: ENV });

  assert.equal(eod.code, 0, eod.stderr);
  const report = eod.json<TicketsJson>();
  assert.deepEqual(report.plan, { start: '2026-11-20', days: [{ date: '2026-11-20', hours: 3, entries: [{ ...id(dueToday), hours: 3 }] }] });
  assert.deepEqual(report.warnings.atRisk, [id(dueToday)]);
  assert.deepEqual(report.replan, [
    {
      ...id(dueToday),
      id: dueToday.id,
      subject: 'due today',
      dueDate: '2026-11-19',
      proposedDueDate: '2026-11-20',
      sharingTickets: [],
      comment: 'Dời hạn từ 19/11/2026 sang 20/11/2026: còn 3h việc, xếp 8h mỗi ngày làm việc theo thứ tự hạn thì xong ngày 20/11/2026. Không trùng ngày với ticket nào.',
    },
  ]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.json<TicketsJson>().plan.start, '2026-11-19');
  assert.deepEqual(plain.json<TicketsJson>().replan, [], 'before 17:00 today still holds its 3h');
  assert.equal(misuse.code, 2);
  assert.match(misuse.stderr, /--eod applies only to tickets/);
});

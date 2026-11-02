import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

interface StoryJson {
  ref: number;
  subject: string;
  status: string;
  closed: boolean;
  blocked: boolean;
  points: number | null;
}

interface ReportJson {
  project: { id: number; slug: string; name: string };
  sprints: {
    id: number;
    name: string;
    start: string;
    finish: string;
    closed: boolean;
    stories: { done: number; total: number };
    tasks: { done: number; total: number };
    points: { done: number; total: number };
    blocked: StoryJson[];
  }[];
  epics: { id: number; ref: number; subject: string; stories: { done: number; open: number } }[];
  noEpic: { done: number; open: number };
  outsideSprints: { done: number; open: number; stories: StoryJson[] };
}

/**
 * Project alpha: a closed sprint, an active one, two epics, and 32 stories in no sprint, so the 37 stories span two
 * of Taiga's 30-item pages. Another project has a sprint of its own that the report never shows.
 */
function seed(fake: FakeTaiga) {
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const other = fake.addProject({ slug: 'other', name: 'Other' });
  const s1 = fake.addMilestone({ project: alpha.id, name: 'Sprint 1', estimated_start: '2026-10-01', estimated_finish: '2026-10-14', closed: true });
  const s2 = fake.addMilestone({ project: alpha.id, name: 'Sprint 2', estimated_start: '2026-10-15', estimated_finish: '2026-10-28' });
  fake.addMilestone({ project: other.id, name: 'Other sprint', estimated_start: '2026-10-01', estimated_finish: '2026-10-14' });
  const auth = fake.addEpic({ project: alpha.id, subject: 'Auth' });
  const billing = fake.addEpic({ project: alpha.id, subject: 'Billing' });

  const story = (subject: string, changes: Partial<FakeUserStory> = {}) => {
    const added = fake.addUserStory({ project: alpha.id, subject });
    Object.assign(added, changes);
    return added;
  };
  const done = { is_closed: true, status_name: 'Done', finish_date: '2026-10-10T10:00:00Z' };
  const login = story('Login', { ...done, milestone: s1.id, total_points: 3 });
  story('Logout', { ...done, milestone: s1.id, total_points: 5 });
  story('Invoices', { ...done, milestone: s2.id, total_points: 2 });
  const sso = story('SSO', { milestone: s2.id, total_points: 3, is_blocked: true, status_name: 'In progress' });
  story('Profile', { milestone: s2.id });
  const backlog: FakeUserStory[] = [];
  for (let i = 1; i <= 32; i += 1) backlog.push(story(`Backlog ${i}`));
  Object.assign(backlog[0]!, done);
  Object.assign(backlog[1]!, { is_blocked: true });

  for (const [milestone, closed] of [[s1.id, true], [s1.id, true], [s1.id, false], [s2.id, true], [s2.id, false], [s2.id, false]] as const) {
    Object.assign(fake.addTask({ project: alpha.id, subject: 'Task', user_story: login.id }), { milestone, is_closed: closed });
  }
  fake.addEpicRelatedUserStory(auth.id, login.id);
  fake.addEpicRelatedUserStory(auth.id, sso.id);
  fake.addEpicRelatedUserStory(billing.id, backlog[0]!.id);
  fake.addEpicRelatedUserStory(billing.id, backlog[2]!.id);
  return { alpha, s1, s2, auth, billing, sso, backlog };
}

test('report sums every sprint, epic and the stories in no sprint, across all pages', async (t) => {
  const h = await startHarness(t);
  const { alpha, s1, s2, auth, billing, sso, backlog } = seed(h.fake);

  const result = await h.taigent(['report', '--project', 'alpha', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<ReportJson>();
  assert.deepEqual(report.project, { id: alpha.id, slug: 'alpha', name: 'Alpha' });
  // Newest sprint first, like Taiga's backlog.
  assert.deepEqual(report.sprints, [
    {
      id: s2.id,
      name: 'Sprint 2',
      start: '2026-10-15',
      finish: '2026-10-28',
      closed: false,
      stories: { done: 1, total: 3 },
      tasks: { done: 1, total: 3 },
      points: { done: 2, total: 5 },
      blocked: [{ ref: sso.ref, subject: 'SSO', status: 'In progress', closed: false, blocked: true, points: 3 }],
    },
    {
      id: s1.id,
      name: 'Sprint 1',
      start: '2026-10-01',
      finish: '2026-10-14',
      closed: true,
      stories: { done: 2, total: 2 },
      tasks: { done: 2, total: 3 },
      points: { done: 8, total: 8 },
      blocked: [],
    },
  ]);
  assert.deepEqual(report.epics, [
    { id: auth.id, ref: auth.ref, subject: 'Auth', stories: { done: 1, open: 1 } },
    { id: billing.id, ref: billing.ref, subject: 'Billing', stories: { done: 1, open: 1 } },
  ]);
  // 37 stories: 4 in epics; of the other 33, Logout and Invoices are done.
  assert.deepEqual(report.noEpic, { done: 2, open: 31 });
  assert.equal(report.outsideSprints.stories.length, 32);
  assert.deepEqual({ done: report.outsideSprints.done, open: report.outsideSprints.open }, { done: 1, open: 31 });
  assert.deepEqual(report.outsideSprints.stories.slice(0, 2), [
    { ref: backlog[0]!.ref, subject: 'Backlog 1', status: 'Done', closed: true, blocked: false, points: null },
    { ref: backlog[1]!.ref, subject: 'Backlog 2', status: 'New', closed: false, blocked: true, points: null },
  ]);
  assert.equal(report.outsideSprints.stories.at(-1)!.subject, 'Backlog 32');
  assert.deepEqual(writes(h.fake), []);
});

test('report prints sprints, epics and the stories in no sprint in text form', async (t) => {
  const h = await startHarness(t);
  const { sso, backlog } = seed(h.fake);

  const result = await h.taigent(['report', '--project', 'alpha']);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Sprint 2 {2}2026-10-15 → 2026-10-28 {2}active\n {4}stories 1\/3 done, tasks 1\/3 done, points 2\/5 done/);
  assert.match(result.stdout, new RegExp(`blocked: #${sso.ref} SSO \\(In progress\\)`));
  assert.match(result.stdout, /Sprint 1 {2}2026-10-01 → 2026-10-14 {2}closed\n {4}stories 2\/2 done, tasks 2\/3 done, points 8\/8 done/);
  assert.match(result.stdout, /#\d+ Auth: 1 done, 1 open/);
  assert.match(result.stdout, /No epic: 2 done, 31 open/);
  assert.match(result.stdout, /Stories in no sprint \(32\): 1 done, 31 open/);
  assert.match(result.stdout, new RegExp(`#${backlog[1]!.ref} Backlog 2 \\(New, blocked\\)`));
  assert.match(result.stdout, /Backlog 32 \(New\)/);
});

test('report of a project without sprints or epics lists every story as outside the sprints', async (t) => {
  const h = await startHarness(t);
  const kanban = h.fake.addProject({ slug: 'kanban', name: 'Kanban' });
  h.fake.addUserStory({ project: kanban.id, subject: 'Card' });

  const result = await h.taigent(['report', '--project', 'kanban', '--json']);

  assert.equal(result.code, 0, result.stderr);
  const report = result.json<ReportJson>();
  assert.deepEqual([report.sprints, report.epics, report.noEpic], [[], [], { done: 0, open: 1 }]);
  assert.equal(report.outsideSprints.stories.length, 1);
  const text = await h.taigent(['report', '--project', 'kanban']);
  assert.match(text.stdout, /No sprints\./);
  assert.match(text.stdout, /No epics\./);
});

test('report needs --project, and a project the user cannot see is a Taiga error (exit 5)', async (t) => {
  const h = await startHarness(t);
  const other = h.fake.addUser({ username: 'other' }).id;
  h.fake.addProject({ slug: 'private-other', name: 'Private', members: [other] });

  const usage = await h.taigent(['report', '--json']);
  assert.equal(usage.code, 2, usage.stderr);
  assert.match(usage.stderr, /--project <slug> is required/);

  const hidden = await h.taigent(['report', '--project', 'private-other', '--json']);
  assert.equal(hidden.code, 5, hidden.stderr);
  assert.equal(hidden.json<{ error: { kind: string } }>().error.kind, 'taiga');
  assert.match(hidden.stderr, /project "private-other" not found/);
});

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { PAGE_SIZE } from './support/fake-taiga.ts';
import { startHarness, writes, type Harness } from './support/harness.ts';

// `taigent snapshot`: one read of the whole backlog on Taiga (every epic, every open story, task and issue, hand-made
// or not), written to taiga/<slug>/snapshot.json for the skills to plan with. Never writes to Taiga.

const SLUG = 'demo-portal';
const STORIES = PAGE_SIZE + 2;

interface SnapshotItem {
  id: number;
  ref: number;
  subject: string;
  status: string | null;
  closed: boolean;
  tags: string[];
  key: string | null;
  description: string;
}

interface Snapshot {
  project: { id: number; slug: string };
  readAt: string;
  epics: SnapshotItem[];
  stories: (SnapshotItem & { epics: number[] })[];
  tasks: (SnapshotItem & { story: number | null })[];
  issues: (SnapshotItem & { type: string | null; severity: string | null; priority: string | null })[];
}

interface Seeded {
  h: Harness;
  refs: { managedEpic: number; handMadeEpic: number; closedEpic: number; firstStory: number; closedStory: number; task: number; closedTask: number; issue: number; closedIssue: number };
}

/** A project worked on by hand and by taigent: more stories than one page, tasks, issues, and closed items of each. */
async function seed(t: Parameters<typeof startHarness>[0]): Promise<Seeded> {
  const h = await startHarness(t);
  const { fake } = h;
  const project = fake.addProject({ slug: SLUG, name: 'Demo - Portal', members: [fake.user.id] });
  const managedEpic = fake.addEpic({ project: project.id, subject: 'Authentication', description: 'Sign-in for everyone.\n', tags: ['src:auth', 'type:feature'] });
  const handMadeEpic = fake.addEpic({ project: project.id, subject: 'Payments', description: 'Written on Taiga.  \r\nSecond line', tags: ['frontend'] });
  const closedEpic = fake.addEpic({ project: project.id, subject: 'Old launch' });
  fake.editItem(closedEpic, { is_closed: true });

  const stories = [];
  for (let i = 1; i <= STORIES; i += 1) stories.push(fake.addUserStory({ project: project.id, subject: `Story ${i}`, description: `Body ${i}` }));
  fake.editItem(stories[0]!, { tags: ['src:auth-login', 'area:web'] });
  fake.addEpicRelatedUserStory(managedEpic.id, stories[0]!.id);
  fake.addEpicRelatedUserStory(handMadeEpic.id, stories[0]!.id);
  const closedStory = fake.addUserStory({ project: project.id, subject: 'Shipped story' });
  fake.editItem(closedStory, { is_closed: true });

  const task = fake.addTask({ project: project.id, subject: 'Build the form', description: 'Use the design system.', user_story: stories[0]!.id });
  const closedTask = fake.addTask({ project: project.id, subject: 'Done task', user_story: stories[0]!.id });
  fake.editItem(closedTask, { is_closed: true });

  const issue = fake.addIssue({ project: project.id, subject: 'Crash on login', description: 'Steps: open the app.', tags: ['src:bug-crash'] });
  const closedStatus = fake.state.issueStatuses.find((s) => s.project === project.id && s.is_closed)!;
  const closedIssue = fake.addIssue({ project: project.id, subject: 'Fixed long ago', status: closedStatus.id });

  return {
    h,
    refs: {
      managedEpic: managedEpic.ref,
      handMadeEpic: handMadeEpic.ref,
      closedEpic: closedEpic.ref,
      firstStory: stories[0]!.ref,
      closedStory: closedStory.ref,
      task: task.ref,
      closedTask: closedTask.ref,
      issue: issue.ref,
      closedIssue: closedIssue.ref,
    },
  };
}

async function readSnapshot(h: Harness): Promise<Snapshot> {
  return JSON.parse(await readFile(join(h.manifestsDir, SLUG, 'snapshot.json'), 'utf8')) as Snapshot;
}

test('snapshot writes every epic and every open story, task and issue to snapshot.json, past the first page', async (t) => {
  const { h, refs } = await seed(t);
  const before = Date.now();

  const result = await h.taigent(['snapshot', '--project', SLUG]);

  assert.equal(result.code, 0, result.stderr);
  const snapshot = await readSnapshot(h);
  const readAt = Date.parse(snapshot.readAt);
  assert.ok(readAt >= before - 1000 && readAt <= Date.now(), snapshot.readAt);
  assert.equal(snapshot.project.slug, SLUG);

  // Every epic, closed ones too.
  assert.deepEqual(snapshot.epics.map((e) => e.ref).sort((a, b) => a - b), [refs.managedEpic, refs.handMadeEpic, refs.closedEpic]);
  assert.equal(snapshot.epics.find((e) => e.ref === refs.closedEpic)!.closed, true);
  assert.deepEqual(snapshot.epics.find((e) => e.ref === refs.managedEpic), {
    id: snapshot.epics.find((e) => e.ref === refs.managedEpic)!.id,
    ref: refs.managedEpic,
    subject: 'Authentication',
    status: 'New',
    closed: false,
    tags: ['src:auth', 'type:feature'],
    key: 'AUTH',
    description: 'Sign-in for everyone.\n',
  });
  // A hand-made item has no key; its description is kept byte for byte.
  const handMade = snapshot.epics.find((e) => e.ref === refs.handMadeEpic)!;
  assert.equal(handMade.key, null);
  assert.deepEqual(handMade.tags, ['frontend']);
  assert.equal(handMade.description, 'Written on Taiga.  \r\nSecond line');

  // More stories than one page of Taiga's list, no closed one.
  assert.ok(snapshot.stories.length > PAGE_SIZE);
  assert.equal(snapshot.stories.length, STORIES);
  assert.ok(snapshot.stories.every((s) => !s.closed));
  assert.ok(!snapshot.stories.some((s) => s.ref === refs.closedStory));
  const first = snapshot.stories.find((s) => s.ref === refs.firstStory)!;
  assert.equal(first.key, 'AUTH-LOGIN');
  assert.equal(first.description, 'Body 1');
  assert.deepEqual([...first.epics].sort((a, b) => a - b), [refs.managedEpic, refs.handMadeEpic]);
  assert.deepEqual(snapshot.stories.find((s) => s.ref !== refs.firstStory)!.epics, []);

  // Open tasks only, with their parent story's ref.
  assert.deepEqual(snapshot.tasks.map((task) => ({ ref: task.ref, story: task.story, subject: task.subject, description: task.description, key: task.key })), [
    { ref: refs.task, story: refs.firstStory, subject: 'Build the form', description: 'Use the design system.', key: null },
  ]);

  // Open issues only, with their value names.
  assert.deepEqual(snapshot.issues.map((i) => ({ ref: i.ref, key: i.key, status: i.status, closed: i.closed, type: i.type, severity: i.severity, priority: i.priority })), [
    { ref: refs.issue, key: 'BUG-CRASH', status: 'New', closed: false, type: 'Bug', severity: 'Normal', priority: 'Normal' },
  ]);

  // A short summary on stdout.
  assert.match(result.stdout, /3 epics, 32 stories, 1 task, 1 issue/);
  assert.match(result.stdout, /snapshot\.json/);
});

test('snapshot sends no write to Taiga and its --json summary counts what it wrote', async (t) => {
  const { h } = await seed(t);

  const result = await h.taigent(['snapshot', '--project', SLUG, '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(writes(h.fake), []);
  const snapshot = await readSnapshot(h);
  assert.deepEqual(result.json(), {
    file: join('taiga', SLUG, 'snapshot.json'),
    readAt: snapshot.readAt,
    epics: 3,
    stories: STORIES,
    tasks: 1,
    issues: 1,
    handMade: 2 + (STORIES - 1) + 1,
  });
});

test('snapshot of a project without manifests creates its directory; an unknown project exits 5 and writes nothing', async (t) => {
  const { h } = await seed(t);

  const missing = await h.taigent(['snapshot', '--project', 'no-such-project', '--json']);
  assert.equal(missing.code, 5, missing.stderr);
  assert.equal(missing.json<{ error: { kind: string } }>().error.kind, 'taiga');
  await assert.rejects(stat(join(h.manifestsDir, 'no-such-project')));

  const again = await h.taigent(['snapshot', '--project', SLUG], { env: { TAIGENT_READ_ONLY: '1' } });
  assert.equal(again.code, 0, again.stderr);
  assert.equal((await readSnapshot(h)).stories.length, STORIES);
});

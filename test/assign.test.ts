import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAssign, planAssign } from '../src/assign.ts';
import { TaigaClient, TaigaConflictError } from '../src/taiga/client.ts';
import { startFakeTaiga, type FakeTaiga } from './support/fake-taiga.ts';
import { startHarness, writes } from './support/harness.ts';

// `taigent members` lists a project's members; `taigent assign` sets the assignee of user stories through the review
// gate like `sprint add`: --yes writes, --dry-run plans, neither refuses with exit 2.

interface MembersJson {
  project: { id: number; slug: string; name: string };
  members: { id: number; username: string; fullName: string; role: string | null }[];
}

interface PlanJson {
  changes: boolean;
  summary: Record<string, number>;
  user: { id: number; username: string; fullName: string };
  onlyUnassigned: boolean;
  operations: { action: string; ref: number; skip: string | null; from: { id: number; username: string | null }[] }[];
}

interface ReportJson {
  operations: { result: string; ref: number }[];
  summary: Record<string, number>;
}

function seed(fake: FakeTaiga) {
  const alice = fake.addUser({ username: 'alice', full_name: 'Alice Nguyen' });
  const bob = fake.addUser({ username: 'bob', full_name: 'Bob Tran' });
  const bob2 = fake.addUser({ username: 'bob2', full_name: 'bob tran' });
  const outsider = fake.addUser({ username: 'outsider', full_name: 'Out Sider' });
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha' });
  const other = fake.addProject({ slug: 'other', name: 'Other' });
  fake.addMembership({ project: alpha.id, role: 'back', user: alice.id });
  fake.addMembership({ project: alpha.id, role: 'front', user: bob.id });
  fake.addMembership({ project: alpha.id, role: 'front', user: bob2.id });
  fake.addMembership({ project: alpha.id, role: 'ux', email: 'invited@example.test' });
  fake.addMembership({ project: other.id, role: 'back', user: outsider.id });
  const login = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Login' }), { assigned_to: alice.id, assigned_users: [alice.id] });
  const logout = Object.assign(fake.addUserStory({ project: alpha.id, subject: 'Logout' }), { assigned_to: bob.id, assigned_users: [bob.id] });
  const profile = fake.addUserStory({ project: alpha.id, subject: 'Profile' });
  const task = fake.addTask({ project: alpha.id, subject: 'A task', user_story: login.id });
  const foreign = fake.addUserStory({ project: other.id, subject: 'Foreign' });
  return { alice, bob, bob2, outsider, alpha, other, login, logout, profile, task, foreign };
}

test('members lists the accepted members of the project with id, username, full name and role; read-only', async (t) => {
  const h = await startHarness(t);
  const { alice, bob, bob2, alpha } = seed(h.fake);
  const me = h.fake.user;

  const result = await h.taigent(['members', '--project', 'alpha', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const list = result.json<MembersJson>();
  assert.deepEqual(list.project, { id: alpha.id, slug: 'alpha', name: 'Alpha' });
  assert.deepEqual(
    list.members,
    [
      { id: alice.id, username: 'alice', fullName: 'Alice Nguyen', role: 'Back' },
      { id: bob.id, username: 'bob', fullName: 'Bob Tran', role: 'Front' },
      { id: bob2.id, username: 'bob2', fullName: 'bob tran', role: 'Front' },
      { id: me.id, username: me.username, fullName: me.username, role: 'Product Owner' },
    ].sort((a, b) => a.username.localeCompare(b.username)),
  );

  const text = await h.taigent(['members', '--project', 'alpha']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /Members of project Alpha \(alpha\): 4/);
  assert.match(text.stdout, new RegExp(`  alice \\(Alice Nguyen\\)  Back  \\(id ${alice.id}\\)`));
  assert.deepEqual(writes(h.fake), []);
});

test('assign needs --yes, plans with --dry-run, then sets assigned_to and assigned_users with the version; a second run is unchanged', async (t) => {
  const h = await startHarness(t);
  const { alice, bob, login, logout, profile } = seed(h.fake);
  const args = ['assign', '--project', 'alpha', '--user', 'alice', String(login.ref), `#${logout.ref}`, String(profile.ref), String(profile.ref)];

  const refused = await h.taigent(args);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /refusing to assign without --yes/);
  assert.match(refused.stdout, new RegExp(`Plan: assign user stories to alice \\(Alice Nguyen\\) \\(id ${alice.id}\\) in project alpha:`));
  assert.match(refused.stdout, new RegExp(`~ story #${logout.ref} Logout  \\(from bob \\(Bob Tran\\)\\)`));
  assert.match(refused.stdout, new RegExp(`~ story #${profile.ref} Profile  \\(unassigned\\)`));
  assert.match(refused.stdout, new RegExp(`skip story #${login.ref} Login  \\(already assigned to alice \\(Alice Nguyen\\)\\)`));

  const dry = await h.taigent([...args, '--dry-run', '--json']);
  assert.equal(dry.code, 3, dry.stderr);
  const plan = dry.json<PlanJson>();
  assert.deepEqual(plan.summary, { update: 2, skip: 1 });
  assert.equal(plan.user.id, alice.id);
  assert.deepEqual(plan.operations.map((op) => [op.ref, op.action, op.skip, op.from.map((u) => u.id)]), [
    [login.ref, 'skip', 'same', [alice.id]],
    [logout.ref, 'update', null, [bob.id]],
    [profile.ref, 'update', null, []],
  ]);
  assert.deepEqual(writes(h.fake), []);

  const versions = [logout.version, profile.version];
  const applied = await h.taigent([...args, '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(applied.json<ReportJson>().summary, { updated: 2, unchanged: 1 });
  assert.deepEqual(writes(h.fake), [`PATCH /userstories/${logout.id}`, `PATCH /userstories/${profile.id}`]);
  const bodies = h.fake.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);
  assert.deepEqual(bodies, [
    { assigned_to: alice.id, assigned_users: [alice.id], version: versions[0] },
    { assigned_to: alice.id, assigned_users: [alice.id], version: versions[1] },
  ]);
  for (const story of [login, logout, profile]) assert.deepEqual([story.assigned_to, story.assigned_users], [alice.id, [alice.id]]);

  const again = await h.taigent([...args, '--yes']);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /3 unchanged/);
  assert.equal(writes(h.fake).length, 2);
});

test('assign resolves --user by full name in any case and by me; a story with a second assignee is updated', async (t) => {
  const h = await startHarness(t);
  const { alice, bob, login, profile } = seed(h.fake);
  login.assigned_users = [alice.id, bob.id];

  const byName = await h.taigent(['assign', '--project', 'alpha', '--user', 'ALICE NGUYEN', String(login.ref), '--dry-run', '--json']);
  assert.equal(byName.code, 3, byName.stderr);
  const plan = byName.json<PlanJson>();
  assert.equal(plan.user.username, 'alice');
  assert.deepEqual(plan.operations.map((op) => [op.action, op.from.map((u) => u.id)]), [['update', [alice.id, bob.id]]]);

  const me = await h.taigent(['assign', '--project', 'alpha', '--user', 'me', String(profile.ref), '--yes', '--json']);
  assert.equal(me.code, 0, me.stderr);
  assert.deepEqual([profile.assigned_to, profile.assigned_users], [h.fake.user.id, [h.fake.user.id]]);
});

test('assign --only-unassigned skips the stories assigned to anyone and assigns the others', async (t) => {
  const h = await startHarness(t);
  const { alice, bob, login, logout, profile } = seed(h.fake);
  const args = ['assign', '--project', 'alpha', '--user', 'alice', '--only-unassigned', String(login.ref), String(logout.ref), String(profile.ref)];

  const refused = await h.taigent(args);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stdout, /\(only unassigned ones\)/);
  assert.match(refused.stdout, new RegExp(`skip story #${logout.ref} Logout  \\(already assigned to bob \\(Bob Tran\\)\\)`));

  const dry = await h.taigent([...args, '--dry-run', '--json']);
  assert.equal(dry.code, 3, dry.stderr);
  const plan = dry.json<PlanJson>();
  assert.equal(plan.onlyUnassigned, true);
  assert.deepEqual(plan.operations.map((op) => [op.ref, op.action, op.skip]), [
    [login.ref, 'skip', 'same'],
    [logout.ref, 'skip', 'assigned'],
    [profile.ref, 'update', null],
  ]);

  const applied = await h.taigent([...args, '--yes', '--json']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(applied.json<ReportJson>().summary, { updated: 1, unchanged: 2 });
  assert.deepEqual(writes(h.fake), [`PATCH /userstories/${profile.id}`]);
  assert.deepEqual([logout.assigned_to, logout.assigned_users], [bob.id, [bob.id]]);
  assert.deepEqual([profile.assigned_to, profile.assigned_users], [alice.id, [alice.id]]);

  // Only assigned_users set (no main assignee) counts as assigned too.
  const other = Object.assign(h.fake.addUserStory({ project: profile.project, subject: 'Shared' }), { assigned_users: [bob.id] });
  const shared = await h.taigent(['assign', '--project', 'alpha', '--user', 'alice', '--only-unassigned', String(other.ref)]);
  assert.equal(shared.code, 0, shared.stderr);
  assert.match(shared.stdout, /No changes\./);
});

test('assign refuses an unknown or ambiguous user, a non-member, and a ref that is no user story of the project, before any write', async (t) => {
  const h = await startHarness(t);
  const { login, task, foreign } = seed(h.fake);
  const members = /its members: alice \(Alice Nguyen\), bob \(Bob Tran\), bob2 \(bob tran\)/;
  const cases: [string[], RegExp[]][] = [
    [['--user', 'carol', String(login.ref)], [/no member "carol" in alpha/, members]],
    [['--user', 'outsider', String(login.ref)], [/no member "outsider" in alpha/]],
    [['--user', 'Bob Tran', String(login.ref)], [/"Bob Tran" is the full name of several members of alpha: bob, bob2; use the username/, members]],
    [['--user', 'alice', String(login.ref), String(task.ref), '999', '999'], [new RegExp(`not a user story of alpha: #${task.ref}, #999;`)]],
    [['--user', 'alice', String(foreign.ref + 1000)], [/not a user story of alpha/]],
  ];
  for (const [rest, messages] of cases) {
    const result = await h.taigent(['assign', '--project', 'alpha', ...rest, '--yes']);
    assert.equal(result.code, 2, result.stderr);
    for (const message of messages) assert.match(result.stderr, message);
  }
  const json = await h.taigent(['assign', '--project', 'alpha', '--user', 'carol', String(login.ref), '--yes', '--json']);
  assert.equal(json.json<{ error: { kind: string } }>().error.kind, 'usage');

  // `me` must be a member too.
  const solo = h.fake.addProject({ slug: 'solo', members: [], is_private: false });
  h.fake.addUserStory({ project: solo.id, subject: 'Solo' });
  const notMember = await h.taigent(['assign', '--project', 'solo', '--user', 'me', '1', '--yes']);
  assert.equal(notMember.code, 2, notMember.stderr);
  assert.match(notMember.stderr, /you \(.+\) are not a member of solo \(it has no member\)/);
  assert.deepEqual(writes(h.fake), []);
});

test('assign turns a stale story version into a conflict naming its ref', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const { alice, bob, profile } = seed(fake);
  const client = await TaigaClient.connect({ apiUrl: fake.url, credentials: { username: fake.user.username, password: fake.user.password }, retryUnitMs: 0 });
  const plan = await planAssign(client, 'alpha', 'alice', [profile.ref]);
  // Someone assigns the story between the plan and the write.
  fake.editItem(profile, { assigned_to: bob.id, assigned_users: [bob.id] });
  await assert.rejects(executeAssign(plan, client), (error) => error instanceof TaigaConflictError && error.key === `#${profile.ref}`);
  assert.equal(profile.assigned_to, bob.id);
  assert.notEqual(profile.assigned_to, alice.id);
});

test('assign and members options are checked', async (t) => {
  const h = await startHarness(t);
  seed(h.fake);
  const cases: [string[], RegExp][] = [
    [['assign', '--project', 'alpha', '1'], /assign needs --user/],
    [['assign', '--project', 'alpha', '--user', ' ', '1'], /assign needs --user/],
    [['assign', '--project', 'alpha', '--user', 'alice'], /assign needs the refs/],
    [['assign', '--project', 'alpha', '--user', 'alice', 'abc'], /assign needs user story refs \(e.g. 84 or #84\), got "abc"/],
    [['assign', '--user', 'alice', '1'], /--project <slug> is required/],
    [['members', '--project', 'alpha', '--user', 'alice'], /--user and --only-unassigned apply only to assign/],
    [['members', '--project', 'alpha', '--only-unassigned'], /--user and --only-unassigned apply only to assign/],
    [['members', '--project', 'alpha', 'extra'], /unexpected argument "extra"/],
    [['members'], /--project <slug> is required/],
  ];
  for (const [args, message] of cases) {
    const result = await h.taigent(args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message);
  }
  assert.equal(h.fake.requests.length, 0);
});

test('under TAIGENT_READ_ONLY assign --yes refuses before contacting Taiga; members and --dry-run still work', async (t) => {
  const h = await startHarness(t);
  const { profile } = seed(h.fake);
  const READ_ONLY = { env: { TAIGENT_READ_ONLY: '1' } };
  const args = ['assign', '--project', 'alpha', '--user', 'alice', String(profile.ref)];
  const result = await h.taigent([...args, '--yes', '--json'], READ_ONLY);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /taigent: assign writes to Taiga.*TAIGENT_READ_ONLY/);
  assert.equal(result.json<{ error: { kind: string } }>().error.kind, 'read-only');
  assert.equal(h.fake.requests.length, 0, 'refused before contacting Taiga');
  assert.equal((await h.taigent([...args, '--dry-run'], READ_ONLY)).code, 3);
  assert.equal((await h.taigent(['members', '--project', 'alpha'], READ_ONLY)).code, 0);
  assert.deepEqual(writes(h.fake), []);
});

// `taigent pull`: brings Taiga's managed values of backlog items into backlog.yaml and makes them the baseline in
// state.json, so a remote edit stops blocking plan. Stories in the user story format are parsed back from their
// template; a description that does not parse changes no file. `--keep-manifest` only moves the baseline, so the next
// apply writes the manifest's values. Pull reads Taiga and writes local files only.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Plan } from '../src/planner.ts';
import type { Preview } from '../src/review.ts';
import { startHarness, writes, type Harness } from './support/harness.ts';
import { LEGACY, LEGACY_DESCRIPTION, seedLegacy } from './support/legacy-story.ts';

const EXIT_BLOCKED = 6;
const EXIT_VALIDATION = 4;

const BACKLOG = `# Backlog of the demo project.
epics:
  - key: AUTH
    subject: Authentication # what the epic is about
    description: Users can sign in.
    tags: [type:feature, area:auth]
    stories:
      # The login story.
      - key: AUTH-LOGIN
        subject: User can log in
        use_case:
          as_a: registered user
          i_want_to: log in with my email
          so_that: I see my projects
        scenarios:
          - scenario: Wrong password
            given: [an account exists]
            when: I enter a wrong password
            then: I see an error
        spec: docs/specs/auth.md
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
      - key: AUTH-LOGOUT
        subject: User can log out
        use_case:
          as_a: signed-in user
          i_want_to: log out
          so_that: nobody else uses my session
        scenarios:
          - scenario: Log out
            given: [I am signed in]
            when: I press Log out
            then: I see the sign-in page
`;

/** The edited login story's description, as a Taiga user rewrote it within the template. */
const EDITED_LOGIN = [
  '- **As a** returning user',
  '- **I want to** log in with my email or my phone',
  '- **so that** I see my projects',
  '',
  'Phone numbers are matched without spaces.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] **Scenario:** Wrong password',
  '  - **Given:** an account exists',
  '  - **and Given:** it is not locked',
  '  - **When:** I enter a wrong password',
  '  - **Then:** I see an error',
  '- [ ] **Scenario:** Phone login',
  '  - **Given:** an account with a phone number',
  '  - **When:** I enter the phone number and the password',
  '  - **Then:** I see my projects',
  '',
  'Spec: docs/specs/login.md',
].join('\n');

interface PullOutput {
  project: { id: number; slug: string };
  keepManifest: boolean;
  pulled: { type: string; key: string; id: number; ref: number; kind: string | null; fields: string[] }[];
}

interface PullError {
  error: { kind: string; message: string; key: string; description: string };
}

/** Applies BACKLOG (or `backlog`) to an empty project, so every item is on Taiga with a baseline. */
async function applied(h: Harness, backlog = BACKLOG): Promise<void> {
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', backlog);
  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(result.code, 0, result.stderr);
}

const backlogPath = (h: Harness) => join(h.manifestsDir, 'demo', 'backlog.yaml');
const statePath = (h: Harness) => join(h.manifestsDir, 'demo', 'state.json');
const story = (h: Harness, key: string) => h.fake.state.userStories.find((s) => s.tags.includes(`src:${key.toLowerCase()}`))!;

test('pull writes a remote edit into backlog.yaml, keeps its comments, and the next plan skips the item', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  const epic = h.fake.state.epics[0]!;
  h.fake.editItem(epic, { subject: 'Sign-in', description: 'Users can sign in with a password.', tags: ['type:feature', 'area:auth', 'area:security', 'src:auth', 'urgent'] });
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, EXIT_BLOCKED);
  h.fake.requests.length = 0;

  const pull = await h.taigent(['pull', '--project', 'demo', '--json']);

  assert.equal(pull.code, 0, pull.stderr);
  assert.deepEqual(pull.json<PullOutput>(), {
    project: { id: epic.project, slug: 'demo' },
    keepManifest: false,
    pulled: [{ type: 'epic', key: 'AUTH', id: epic.id, ref: epic.ref, kind: 'remote-edit', fields: ['subject', 'description', 'tags'] }],
  });
  assert.deepEqual(writes(h.fake), []);
  const backlog = await readFile(backlogPath(h), 'utf8');
  assert.equal(
    backlog,
    BACKLOG.replace('subject: Authentication #', 'subject: Sign-in #')
      .replace('description: Users can sign in.', 'description: Users can sign in with a password.')
      .replace('tags: [type:feature, area:auth]', 'tags: [type:feature, area:auth, area:security]'),
  );
  assert.deepEqual((await h.readState('demo'))?.items.AUTH?.baseline, {
    subject: 'Sign-in',
    description: 'Users can sign in with a password.',
    tags: ['type:feature', 'area:auth', 'area:security'],
    custom_attributes: {},
  });

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  const { operations, blocked } = plan.json<Plan>();
  assert.deepEqual(blocked, []);
  assert.ok(operations.every((op) => op.action === 'skip'), JSON.stringify(operations));
});

test('pull parses an edited user-story-format story back into use case, context, scenarios and spec', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  h.fake.editItem(story(h, 'AUTH-LOGIN'), { description: EDITED_LOGIN });

  const pull = await h.taigent(['pull', '--project', 'demo', '--key', 'AUTH-LOGIN']);

  assert.equal(pull.code, 0, pull.stderr);
  assert.match(pull.stdout, /AUTH-LOGIN/);
  const backlog = await readFile(backlogPath(h), 'utf8');
  assert.equal(
    backlog,
    BACKLOG.replace(
      `          as_a: registered user
          i_want_to: log in with my email
          so_that: I see my projects
        scenarios:
          - scenario: Wrong password
            given: [an account exists]
            when: I enter a wrong password
            then: I see an error
        spec: docs/specs/auth.md
`,
      `          as_a: returning user
          i_want_to: log in with my email or my phone
          so_that: I see my projects
        scenarios:
          - scenario: Wrong password
            given:
              - an account exists
              - it is not locked
            when: I enter a wrong password
            then: I see an error
          - scenario: Phone login
            given:
              - an account with a phone number
            when: I enter the phone number and the password
            then: I see my projects
        description: Phone numbers are matched without spaces.
        spec: docs/specs/login.md
`,
    ),
  );
  assert.equal((await h.readState('demo'))?.items['AUTH-LOGIN']?.baseline?.description, EDITED_LOGIN);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.deepEqual(plan.json<Plan>().blocked, []);
});

test('pull parses an edited legacy story back into its description, acceptance criteria and spec', async (t) => {
  const h = await startHarness(t);
  const legacy = seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY);
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  h.fake.editItem(legacy, { description: LEGACY_DESCRIPTION.replace('- [ ] Session survives a reload', '- [ ] Session survives a reload\n- [ ] Locked after 5 tries') });

  const pull = await h.taigent(['pull', '--project', 'demo']);

  assert.equal(pull.code, 0, pull.stderr);
  assert.equal(await readFile(backlogPath(h), 'utf8'), LEGACY.replace('          - Session survives a reload\n', '          - Session survives a reload\n          - Locked after 5 tries\n'));
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, 0);
});

test('pull moves a task the team moved to another story on Taiga', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  const task = h.fake.state.tasks.find((s) => s.tags.includes('src:auth-login-api'))!;
  h.fake.editItem(task, { user_story: story(h, 'AUTH-LOGOUT').id });

  const pull = await h.taigent(['pull', '--project', 'demo', '--json']);

  assert.equal(pull.code, 0, pull.stderr);
  assert.deepEqual(pull.json<PullOutput>().pulled.map((item) => [item.key, item.fields]), [['AUTH-LOGIN-API', ['story']]]);
  const backlog = await readFile(backlogPath(h), 'utf8');
  assert.ok(backlog.indexOf('key: AUTH-LOGIN-API') > backlog.indexOf('key: AUTH-LOGOUT'), backlog);
  assert.equal((await h.taigent(['plan', '--project', 'demo'])).code, 0);
});

test('a description that does not follow the template: exit 4, the raw description in --json, no file changed', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  const free = 'Log in with email.\n\nNo template here, just notes from the meeting.';
  h.fake.editItem(story(h, 'AUTH-LOGIN'), { description: free });
  // Another blocked item, to show that pull changes nothing at all when one item fails.
  h.fake.editItem(h.fake.state.epics[0]!, { subject: 'Sign-in' });
  const backlogBefore = await readFile(backlogPath(h), 'utf8');
  const stateBefore = await readFile(statePath(h), 'utf8');

  const pull = await h.taigent(['pull', '--project', 'demo', '--json']);

  assert.equal(pull.code, EXIT_VALIDATION, pull.stderr);
  const { error } = pull.json<PullError>();
  assert.equal(error.kind, 'pull');
  assert.equal(error.key, 'AUTH-LOGIN');
  assert.equal(error.description, free);
  assert.match(pull.stderr, /AUTH-LOGIN/);
  assert.equal(await readFile(backlogPath(h), 'utf8'), backlogBefore);
  assert.equal(await readFile(statePath(h), 'utf8'), stateBefore);
});

test('--keep-manifest leaves backlog.yaml and moves the baseline to Taiga, so apply writes the manifest value', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  const epic = h.fake.state.epics[0]!;
  h.fake.editItem(epic, { subject: 'Sign-in' });
  const backlogBefore = await readFile(backlogPath(h), 'utf8');

  const pull = await h.taigent(['pull', '--project', 'demo', '--key', 'AUTH', '--keep-manifest', '--json']);

  assert.equal(pull.code, 0, pull.stderr);
  assert.equal(pull.json<PullOutput>().keepManifest, true);
  assert.equal(await readFile(backlogPath(h), 'utf8'), backlogBefore);
  assert.equal((await h.readState('demo'))?.items.AUTH?.baseline?.subject, 'Sign-in');

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  assert.deepEqual(
    plan.json<Plan>().operations.flatMap((op) => (op.action === 'update' ? [[op.key, op.changes.subject]] : [])),
    [['AUTH', { from: 'Sign-in', to: 'Authentication' }]],
  );
  const apply = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(apply.code, 0, apply.stderr);
  assert.equal(epic.subject, 'Authentication');
});

test('the verdict of a pulled item turns stale in the review', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  const before = (await h.taigent(['preview', '--project', 'demo', '--json'])).json<Preview>();
  const digest = before.epics[0]!.digest;
  await h.writeManifest('demo', 'review.yaml', `items:\n  AUTH:\n    verdict: approved\n    digest: ${digest}\n`);
  assert.equal((await h.taigent(['preview', '--project', 'demo', '--json'])).json<Preview>().epics[0]!.review.stale, false);
  h.fake.editItem(h.fake.state.epics[0]!, { subject: 'Sign-in' });

  assert.equal((await h.taigent(['pull', '--project', 'demo'])).code, 0);

  const after = (await h.taigent(['preview', '--project', 'demo', '--json'])).json<Preview>();
  assert.equal(after.epics[0]!.review.verdict, 'approved');
  assert.equal(after.epics[0]!.review.stale, true);
  assert.equal(after.summary.stale, 1);
});

test('pull runs under TAIGENT_READ_ONLY, never writes to Taiga, and has nothing to do without blocked items', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  h.fake.requests.length = 0;

  const nothing = await h.taigent(['pull', '--project', 'demo', '--json'], { env: { TAIGENT_READ_ONLY: '1' } });
  assert.equal(nothing.code, 0, nothing.stderr);
  assert.deepEqual(nothing.json<PullOutput>().pulled, []);

  h.fake.editItem(h.fake.state.epics[0]!, { subject: 'Sign-in' });
  const pull = await h.taigent(['pull', '--project', 'demo'], { env: { TAIGENT_READ_ONLY: '1' } });
  assert.equal(pull.code, 0, pull.stderr);
  assert.deepEqual(writes(h.fake), []);
  assert.match(await readFile(backlogPath(h), 'utf8'), /subject: Sign-in/);
});

test('pull refuses a key that is not in backlog.yaml or not on Taiga yet, and --keep-manifest elsewhere', async (t) => {
  const h = await startHarness(t);
  await applied(h);
  await writeFile(backlogPath(h), `${BACKLOG}  - key: BILLING\n    subject: Billing\n`);

  const unknown = await h.taigent(['pull', '--project', 'demo', '--key', 'NOPE', '--json']);
  assert.equal(unknown.code, 2, unknown.stderr);
  assert.match(unknown.stderr, /NOPE/);
  const missing = await h.taigent(['pull', '--project', 'demo', '--key', 'BILLING', '--json']);
  assert.equal(missing.code, 2, missing.stderr);
  assert.match(missing.stderr, /BILLING.*not on Taiga/);
  const misplaced = await h.taigent(['plan', '--project', 'demo', '--keep-manifest']);
  assert.equal(misplaced.code, 2);
});

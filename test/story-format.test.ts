import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readItem, readManifestFile, saveItem } from '../src/edit.ts';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import type { Plan } from '../src/planner.ts';
import { OFFLINE, startHarness, writes, type Harness } from './support/harness.ts';
import type { FakeUserStory } from './support/fake-taiga.ts';

interface ErrorOutput {
  error: { kind: string; issues?: ManifestIssue[] };
}

test('apply renders a use case + scenarios story: use case, context, one checkbox per scenario with its Given/When/Then, spec', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: Sign in to reach my projects
        use_case:
          as_a: returning team member
          i_want_to: sign in with my password
          so_that: I land on my project list
        description: Single sign-on comes later.
        scenarios:
          - scenario: Wrong password
            given:
              - I have an account
              - I am on the sign-in page
            when: I submit a wrong password
            then: I see "Invalid credentials"
          - scenario: Session survives a reload
            given: [I am signed in]
            when: I reload the page
            then: I am still signed in
        spec: docs/specs/auth.md
      - key: AUTH-LOGOUT
        subject: Sign out on a shared computer
        use_case: { as_a: team member, i_want_to: sign out, so_that: nobody else uses my session }
        scenarios:
          - { scenario: Sign out, given: [I am signed in], when: I click Sign out, then: I see the sign-in page }
`);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    h.fake.state.userStories.map((s) => s.description),
    [
      [
        '- **As a** returning team member',
        '- **I want to** sign in with my password',
        '- **so that** I land on my project list',
        '',
        'Single sign-on comes later.',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] **Scenario:** Wrong password',
        '  - **Given:** I have an account',
        '  - **and Given:** I am on the sign-in page',
        '  - **When:** I submit a wrong password',
        '  - **Then:** I see "Invalid credentials"',
        '- [ ] **Scenario:** Session survives a reload',
        '  - **Given:** I am signed in',
        '  - **When:** I reload the page',
        '  - **Then:** I am still signed in',
        '',
        'Spec: docs/specs/auth.md',
      ].join('\n'),
      [
        '- **As a** team member',
        '- **I want to** sign out',
        '- **so that** nobody else uses my session',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] **Scenario:** Sign out',
        '  - **Given:** I am signed in',
        '  - **When:** I click Sign out',
        '  - **Then:** I see the sign-in page',
      ].join('\n'),
    ],
  );
  const plan = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /No changes/);
});

/** One epic holding the given story fields (YAML, indented as story fields). */
function backlogWith(storyFields: string): string {
  return `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: Sign in
${storyFields}`;
}

const AT = 'epics[0].stories[0]';

const CASES: { name: string; fields: string; issues: [string, string][] }[] = [
  {
    name: 'a use case missing each of its three parts',
    fields: `        use_case: { as_a: '' }
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [
      [`${AT}.use_case.as_a`, 'required'],
      [`${AT}.use_case.i_want_to`, 'required'],
      [`${AT}.use_case.so_that`, 'required'],
    ],
  },
  {
    name: 'a use case that is not a mapping',
    fields: `        use_case: [a, b]
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [[`${AT}.use_case`, 'type']],
  },
  {
    name: 'a use case part that is a list',
    fields: `        use_case: { as_a: [x], i_want_to: y, so_that: z }
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [[`${AT}.use_case.as_a`, 'type']],
  },
  {
    name: 'a scenario without a name, with an empty given, a list when and an empty then',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios:
          - { given: [], when: [a, b], then: '' }
`,
    issues: [
      [`${AT}.scenarios[0].scenario`, 'required'],
      [`${AT}.scenarios[0].given`, 'required'],
      [`${AT}.scenarios[0].when`, 'type'],
      [`${AT}.scenarios[0].then`, 'required'],
    ],
  },
  {
    name: 'a scenario with a missing when, a list then, a non-list given and a scenario that is not a mapping',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios:
          - { scenario: S, given: g, then: [a] }
          - just text
`,
    issues: [
      [`${AT}.scenarios[0].given`, 'type'],
      [`${AT}.scenarios[0].when`, 'required'],
      [`${AT}.scenarios[0].then`, 'type'],
      [`${AT}.scenarios[1]`, 'type'],
    ],
  },
  {
    name: 'a given entry that is empty',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios: [{ scenario: S, given: [ok, ''], when: w, then: t }]
`,
    issues: [[`${AT}.scenarios[0].given`, 'type']],
  },
  {
    name: 'an empty scenarios list',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios: []
`,
    issues: [[`${AT}.scenarios`, 'required']],
  },
  {
    name: 'scenarios that is not a list',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios: one scenario
`,
    issues: [[`${AT}.scenarios`, 'type']],
  },
  {
    name: 'unknown fields in the use case and in a scenario',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z, because: w }
        scenarios: [{ scenario: S, given: [g], and: h, when: w, then: t }]
`,
    issues: [
      [`${AT}.use_case.because`, 'known-field'],
      [`${AT}.scenarios[0].and`, 'known-field'],
    ],
  },
  {
    name: 'a use case without scenarios',
    fields: `        use_case: { as_a: x, i_want_to: y, so_that: z }
`,
    issues: [[`${AT}.scenarios`, 'story-format']],
  },
  {
    name: 'scenarios without a use case',
    fields: `        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [[`${AT}.use_case`, 'story-format']],
  },
  {
    name: 'acceptance criteria mixed with the new format',
    fields: `        acceptance_criteria: [Works]
        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [[`${AT}.acceptance_criteria`, 'story-format']],
  },
  {
    name: 'acceptance criteria mixed with scenarios only',
    fields: `        acceptance_criteria: [Works]
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
`,
    issues: [
      [`${AT}.use_case`, 'story-format'],
      [`${AT}.acceptance_criteria`, 'story-format'],
    ],
  },
];

for (const { name, fields, issues } of CASES) {
  test(`validate, plan and apply reject ${name} with exit 4 and no request`, async (t) => {
    const h = await startHarness(t);
    h.fake.addProject({ slug: 'demo' });
    await h.writeManifest('demo', 'backlog.yaml', backlogWith(fields));

    const validate = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });
    assert.equal(validate.code, 4, validate.stderr);
    const { error } = validate.json<ErrorOutput>();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(error.issues?.map((i) => [i.path, i.rule]), issues);

    for (const args of [['plan', '--project', 'demo', '--json'], ['apply', '--project', 'demo', '--yes', '--json']]) {
      const result = await h.taigent(args);
      assert.equal(result.code, 4, `${args[0]}: ${result.stderr}`);
      assert.deepEqual(result.json<ErrorOutput>().error.issues?.map((i) => [i.path, i.rule]), issues);
    }
    assert.deepEqual(h.fake.requests, [], 'Taiga is not contacted');
  });
}

test('a complete use case + scenarios story validates offline', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', backlogWith(`        use_case: { as_a: x, i_want_to: y, so_that: z }
        scenarios: [{ scenario: S, given: [g], when: w, then: t }]
        tags: [type:feature]
`));

  const result = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
});

/** A legacy story (description + acceptance_criteria + spec) under epic AUTH. */
const LEGACY = `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        description: As a user I want to log in so that I see my projects.
        acceptance_criteria:
          - Wrong password shows an error
          - Session survives a reload
        spec: docs/specs/auth.md
`;

/** The legacy template of LEGACY's story, byte for byte as taigent rendered it on Taiga. */
const LEGACY_DESCRIPTION = [
  'As a user I want to log in so that I see my projects.',
  '',
  '## Acceptance criteria',
  '',
  '- [ ] Wrong password shows an error',
  '- [ ] Session survives a reload',
  '',
  'Spec: docs/specs/auth.md',
].join('\n');

/** Seeds LEGACY on the fake as taigent created it: epic and story tagged `src:<key>`, linked, legacy description. */
function seedLegacy(h: Harness): FakeUserStory {
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['src:auth'] });
  const story = h.fake.addUserStory({ project: project.id, subject: 'User can log in', description: LEGACY_DESCRIPTION, tags: ['src:auth-login'] });
  h.fake.addEpicRelatedUserStory(epic.id, story.id);
  return story;
}

test('plan and apply refuse to create stories without use_case/scenarios: exit 4, every story-format issue, nothing written', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', `${LEGACY}      - { key: AUTH-NEW, subject: Sign out, use_case: { as_a: x, i_want_to: y, so_that: z }, scenarios: [{ scenario: S, given: [g], when: w, then: t }] }
      - { key: AUTH-LOGOUT, subject: User can log out }
  - key: ACCOUNT
    subject: Account
    stories:
      - key: ACCOUNT-EDIT
        subject: User can edit the profile
        acceptance_criteria: [Name is saved]
`);
  // The format of a new story is not an offline rule: validate cannot know which stories are new.
  assert.equal((await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE })).code, 0);

  for (const args of [['plan', '--project', 'demo', '--json'], ['apply', '--project', 'demo', '--yes', '--json']]) {
    const result = await h.taigent(args);
    assert.equal(result.code, 4, `${args[0]}: ${result.stderr}`);
    const { error } = result.json<ErrorOutput>();
    assert.equal(error.kind, 'validation');
    assert.deepEqual(
      error.issues?.map((i) => [i.file.replaceAll('\\', '/'), i.path, i.rule]),
      [
        ['taiga/demo/backlog.yaml', 'epics[0].stories[0]', 'story-format'],
        ['taiga/demo/backlog.yaml', 'epics[0].stories[2]', 'story-format'],
        ['taiga/demo/backlog.yaml', 'epics[1].stories[0]', 'story-format'],
      ],
    );
  }
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(text.code, 4);
  assert.match(text.stderr, /backlog\.yaml: epics\[0\]\.stories\[0\]: .* \[story-format\]/);
  assert.deepEqual(writes(h.fake), [], 'nothing is written to Taiga');
  assert.deepEqual([h.fake.state.epics.length, h.fake.state.userStories.length], [0, 0]);
  assert.equal(await h.readState('demo'), undefined);
});

test('a legacy story already on Taiga is left alone: plan reports No changes, without any state.json', async (t) => {
  const h = await startHarness(t);
  seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 0, plan.stderr);
  assert.deepEqual(plan.json<Plan>().summary, { create: 0, update: 0, link: 0, skip: 2 });
  const text = await h.taigent(['plan', '--project', 'demo']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /No changes/);
  const applied = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(writes(h.fake), []);
});

test('state.json is only a cache: a legacy story it lists but missing on Taiga is still refused', async (t) => {
  const h = await startHarness(t);
  const story = seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY);
  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  assert.equal((await h.readState('demo'))?.items['AUTH-LOGIN']?.id, story.id);
  // Someone strips the identity tag on Taiga: the story is no longer taigent's, whatever state.json says.
  h.fake.editItem(story, { tags: [] });

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);

  assert.equal(plan.code, 4, plan.stderr);
  assert.deepEqual(plan.json<ErrorOutput>().error.issues?.map((i) => [i.path, i.rule]), [['epics[0].stories[0]', 'story-format']]);
});

test('a legacy story on Taiga whose subject changes is updated, not refused', async (t) => {
  const h = await startHarness(t);
  const story = seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY.replace('subject: User can log in', 'subject: User can sign in'));

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const { operations } = plan.json<Plan>();
  assert.deepEqual(
    operations.filter((op) => op.action !== 'skip').map((op) => [op.action, op.key, op.action === 'update' ? Object.keys(op.changes) : []]),
    [['update', 'AUTH-LOGIN', ['subject']]],
  );

  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  assert.deepEqual([story.subject, story.description], ['User can sign in', LEGACY_DESCRIPTION]);
});

test('converting a legacy story on Taiga to use_case + scenarios updates its description', async (t) => {
  const h = await startHarness(t);
  const story = seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', `epics:
  - key: AUTH
    subject: Authentication
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        use_case: { as_a: user, i_want_to: log in, so_that: I see my projects }
        scenarios:
          - { scenario: Wrong password, given: [I am on the sign-in page], when: I submit a wrong password, then: I see an error }
`);

  const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
  assert.equal(plan.code, 3, plan.stderr);
  const updates = plan.json<Plan>().operations.filter((op) => op.action === 'update');
  assert.deepEqual(updates.map((op) => [op.key, Object.keys(op.changes)]), [['AUTH-LOGIN', ['description']]]);

  assert.equal((await h.taigent(['apply', '--project', 'demo', '--yes'])).code, 0);
  assert.equal(
    story.description,
    [
      '- **As a** user',
      '- **I want to** log in',
      '- **so that** I see my projects',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] **Scenario:** Wrong password',
      '  - **Given:** I am on the sign-in page',
      '  - **When:** I submit a wrong password',
      '  - **Then:** I see an error',
    ].join('\n'),
  );
});

test('through the edit API (the story form), editing a legacy story keeps its format; converting it updates the description', async (t) => {
  const h = await startHarness(t);
  seedLegacy(h);
  await h.writeManifest('demo', 'backlog.yaml', LEGACY);
  const dir = join(h.manifestsDir, 'demo');
  const updates = async () => {
    const plan = await h.taigent(['plan', '--project', 'demo', '--json']);
    assert.equal(plan.code, 3, plan.stderr);
    return plan.json<Plan>().operations.flatMap((op) => (op.action === 'update' ? [[op.key, Object.keys(op.changes)]] : []));
  };

  const file = await readManifestFile(dir, 'backlog');
  const story = readItem(file.text, 'story', 'AUTH-LOGIN');
  assert.ok(story?.type === 'story');
  const edited = await saveItem(dir, { baseDigest: file.digest, original: 'AUTH-LOGIN', item: { ...story, fields: { ...story.fields, subject: 'User can sign in' } } });
  assert.equal(edited.status, 'saved');
  assert.equal(await readFile(join(dir, 'backlog.yaml'), 'utf8'), LEGACY.replace('subject: User can log in', 'subject: User can sign in'));
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['subject']]]);

  // "Chuyển sang user story format": the form sends a use case and scenarios instead of acceptance_criteria.
  const { acceptanceCriteria: _criteria, ...rest } = story.fields;
  const converted = await saveItem(dir, {
    baseDigest: edited.digest,
    original: 'AUTH-LOGIN',
    item: {
      ...story,
      fields: {
        ...rest,
        useCase: { asA: 'user', iWantTo: 'log in', soThat: 'I see my projects' },
        scenarios: [{ scenario: 'Wrong password', given: ['I am on the sign-in page'], when: 'I submit a wrong password', then: 'I see an error' }],
      },
    },
  });
  assert.equal(converted.status, 'saved');
  const text = await readFile(join(dir, 'backlog.yaml'), 'utf8');
  assert.doesNotMatch(text, /acceptance_criteria/);
  assert.deepEqual(await updates(), [['AUTH-LOGIN', ['description']]]);
  assert.equal((await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE })).code, 0);
});

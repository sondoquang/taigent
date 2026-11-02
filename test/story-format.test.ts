import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import { startHarness } from './support/harness.ts';

interface ErrorOutput {
  error: { kind: string; issues?: ManifestIssue[] };
}

/** No Taiga connection at all: validate must work offline, without any TAIGA_* variable. */
const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

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

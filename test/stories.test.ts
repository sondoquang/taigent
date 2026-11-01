import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startHarness } from './support/harness.ts';

const TREE = `epics:
  - key: AUTH
    subject: Authentication
    tags: [area:auth]
    stories:
      - key: AUTH-LOGIN
        subject: User can log in
        description: As a user I want to log in so that I see my projects.
        acceptance_criteria:
          - Wrong password shows an error
          - Session survives a reload
        spec: docs/specs/auth.md
        tags: [type:feature]
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            description: POST /login returns a session.
          - key: AUTH-LOGIN-UI
            subject: Login form
      - key: AUTH-LOGOUT
        subject: User can log out
`;

test('apply creates stories with the description template and tags, and tasks under their parent story', async (t) => {
  const h = await startHarness(t);
  const project = h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', TREE);

  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);

  assert.equal(result.code, 0, result.stderr);
  const stories = h.fake.state.userStories;
  assert.deepEqual(
    stories.map((s) => ({ project: s.project, subject: s.subject, description: s.description, tags: s.tags })),
    [
      {
        project: project.id,
        subject: 'User can log in',
        description: [
          'As a user I want to log in so that I see my projects.',
          '',
          '## Acceptance criteria',
          '',
          '- [ ] Wrong password shows an error',
          '- [ ] Session survives a reload',
          '',
          'Spec: docs/specs/auth.md',
        ].join('\n'),
        tags: ['type:feature', 'src:auth-login'],
      },
      { project: project.id, subject: 'User can log out', description: '', tags: ['src:auth-logout'] },
    ],
  );
  const [login] = stories;
  assert.deepEqual(
    h.fake.state.tasks.map((task) => ({ project: task.project, user_story: task.user_story, subject: task.subject, description: task.description, tags: task.tags })),
    [
      { project: project.id, user_story: login!.id, subject: 'Login endpoint', description: 'POST /login returns a session.', tags: ['src:auth-login-api'] },
      { project: project.id, user_story: login!.id, subject: 'Login form', description: '', tags: ['src:auth-login-ui'] },
    ],
  );
  const state = await h.readState('demo');
  assert.deepEqual(
    Object.entries(state!.items).map(([key, entry]) => [key, entry.type]),
    [
      ['AUTH', 'epic'],
      ['AUTH-LOGIN', 'story'],
      ['AUTH-LOGIN-API', 'task'],
      ['AUTH-LOGIN-UI', 'task'],
      ['AUTH-LOGOUT', 'story'],
    ],
  );
  assert.equal(state!.items['AUTH-LOGIN-API']!.id, h.fake.state.tasks[0]!.id);
});

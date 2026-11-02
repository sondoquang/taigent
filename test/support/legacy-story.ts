// A legacy-format story already on Taiga, shared by the story format tests (CLI) and the edit API tests.

import type { FakeUserStory } from './fake-taiga.ts';
import type { Harness } from './harness.ts';

/** A legacy story (description + acceptance_criteria + spec) under epic AUTH. */
export const LEGACY = `epics:
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
export const LEGACY_DESCRIPTION = [
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
export function seedLegacy(h: Harness): FakeUserStory {
  const project = h.fake.addProject({ slug: 'demo' });
  const epic = h.fake.addEpic({ project: project.id, subject: 'Authentication', tags: ['src:auth'] });
  const story = h.fake.addUserStory({ project: project.id, subject: 'User can log in', description: LEGACY_DESCRIPTION, tags: ['src:auth-login'] });
  h.fake.addEpicRelatedUserStory(epic.id, story.id);
  return story;
}

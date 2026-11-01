import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplyReport } from '../src/executor.ts';
import { startHarness } from './support/harness.ts';

const BACKLOG = `epics:
  - { key: AUTH, subject: Authentication }
  - { key: BILLING, subject: Billing }
  - { key: SEARCH, subject: Search }
`;

test('an access token that expires mid-apply is refreshed via /auth/refresh and the job completes', async (t) => {
  const h = await startHarness(t);
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  // by_slug, list epics and the first create go through; the token expires before the second create.
  h.fake.expireTokens({ after: 3 });

  const result = await h.taigent(['apply', '--project', 'demo', '--yes', '--json']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json<ApplyReport>().summary.created, 3);
  assert.deepEqual(h.fake.state.epics.map((e) => e.subject), ['Authentication', 'Billing', 'Search']);
  assert.deepEqual(
    h.fake.requests.filter((r) => r.path.startsWith('/auth')).map((r) => r.path),
    ['/auth', '/auth/refresh'],
  );
});

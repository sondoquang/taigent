// Shared steps of the backlog tests: a backlog applied to an empty project, and the ids of a project's issue values
// on the fake.

import assert from 'node:assert/strict';
import type { FakeIssueValue } from './fake-taiga.ts';
import type { Harness } from './harness.ts';

/** Adds project `demo` to the fake and applies `backlog` to it, so every item is on Taiga with a baseline in state.json. */
export async function applied(h: Harness, backlog: string): Promise<void> {
  h.fake.addProject({ slug: 'demo' });
  await h.writeManifest('demo', 'backlog.yaml', backlog);
  const result = await h.taigent(['apply', '--project', 'demo', '--yes']);
  assert.equal(result.code, 0, result.stderr);
}

/** Id of the value named `name` in one of the project's issue value lists on the fake. */
export function valueId(h: Harness, list: 'issueStatuses' | 'issueTypes' | 'severities' | 'priorities', project: number, name: string): number {
  const value = (h.fake.state[list] as FakeIssueValue[]).find((v) => v.project === project && v.name === name);
  assert.ok(value, `no ${list} value "${name}" in project ${project}`);
  return value.id;
}

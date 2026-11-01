import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import { startHarness } from './support/harness.ts';

const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

test('validate checks project.yaml against the naming conventions, offline', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'vigo-devops',
    'project.yaml',
    `name: Vigo-Devops
slug: vigo-authenautho
description: Deployment tooling.
template: waterfall
modules: [epics, wiki, gantt]
tags:
  - name: priority:high
  - name: type:feature
    color: "#000000"
custom_attributes:
  userstory:
    - name: Owner
  task:
    - name: Size
      type: dropdown
members:
  - username: alice
    email: alice@example.test
    role: Back
  - email: not-an-email
    role: Front
owner: someone
`,
  );

  const result = await h.taigent(['validate', '--project', 'vigo-devops', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const issues = result.json<{ error: { issues: ManifestIssue[] } }>().error.issues;
  assert.deepEqual(
    issues.map((i) => [i.file.replaceAll('\\', '/'), i.path, i.rule]),
    [
      ['taiga/vigo-devops/project.yaml', 'owner', 'known-field'],
      ['taiga/vigo-devops/project.yaml', 'name', 'project-name'],
      ['taiga/vigo-devops/project.yaml', 'slug', 'project-slug'],
      ['taiga/vigo-devops/project.yaml', 'slug', 'project-dir'],
      ['taiga/vigo-devops/project.yaml', 'template', 'template'],
      ['taiga/vigo-devops/project.yaml', 'modules[2]', 'module-known'],
      ['taiga/vigo-devops/project.yaml', 'tags[0].name', 'tag-prefix'],
      ['taiga/vigo-devops/project.yaml', 'tags[1].color', 'tag-color'],
      ['taiga/vigo-devops/project.yaml', 'custom_attributes.userstory', 'known-field'],
      ['taiga/vigo-devops/project.yaml', 'custom_attributes.task[0].type', 'attribute-type'],
      ['taiga/vigo-devops/project.yaml', 'members[0]', 'member-identity'],
      ['taiga/vigo-devops/project.yaml', 'members[1].email', 'member-email'],
    ],
  );
  assert.deepEqual(h.fake.requests, []);
});

test('validate accepts a conventional project.yaml', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest(
    'vigo-core-mapping',
    'project.yaml',
    `name: Vigo - Core Mapping
slug: vigo-core-mapping
description: Map engine.
template: kanban
modules: [epics, wiki]
tags:
  - name: type:bug
  - name: area:tiles
`,
  );

  const result = await h.taigent(['validate', '--project', 'vigo-core-mapping'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /project\.yaml: ok/);
});

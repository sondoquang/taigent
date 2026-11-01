// Contract of the fake Taiga itself: it must reject bad payloads the way Taiga does, otherwise the
// CLI tests could pass against payloads the real server refuses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecord } from '../src/guards.ts';
import { startFakeTaiga, type FakeTaiga } from './support/fake-taiga.ts';

async function login(fake: FakeTaiga): Promise<string> {
  const response = await fetch(`${fake.url}/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'normal', username: fake.user.username, password: fake.user.password }),
  });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(isRecord(body) && typeof body.auth_token === 'string');
  return body.auth_token;
}

async function postEpic(fake: FakeTaiga, token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${fake.url}/epics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('fake Taiga rejects epic payloads with missing or wrong fields with 400, like Taiga', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const token = await login(fake);

  assert.deepEqual(await postEpic(fake, token, { subject: 'No project' }), {
    status: 400,
    body: { project: ['This field is required.'] },
  });
  assert.deepEqual(await postEpic(fake, token, { project_id: project.id, subject: 'Wrong field name' }), {
    status: 400,
    body: {
      project_id: ['Unknown field (the fake Taiga rejects unknown fields).'],
      project: ['This field is required.'],
    },
  });
  const badTag = await postEpic(fake, token, { project: project.id, subject: 'Bad tag', tags: [['x', 'red']] });
  assert.equal(badTag.status, 400);
  assert.equal(fake.state.epics.length, 0);

  const ok = await postEpic(fake, token, { project: project.id, subject: 'Fine', tags: ['SRC:Fine'] });
  assert.equal(ok.status, 201);
  assert.ok(isRecord(ok.body));
  assert.deepEqual(ok.body.tags, [['src:fine', null]], 'tags are lowercased, returned as pairs');
});

test('fake Taiga requires a bearer token outside /auth', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const response = await fetch(`${fake.url}/epics`, { headers: { 'x-disable-pagination': 'True' } });
  assert.equal(response.status, 401);
});

async function send(fake: FakeTaiga, token: string, method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${fake.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('fake Taiga rejects the payload mistakes of the MCP batch tools (projectId, userStoryId, numeric points)', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const token = await login(fake);

  const story = await send(fake, token, 'POST', '/userstories', { projectId: project.id, subject: 'S', points: 3 });
  assert.equal(story.status, 400);
  assert.deepEqual(Object.keys(story.body as object).sort(), ['points', 'project', 'projectId']);
  const ok = await send(fake, token, 'POST', '/userstories', { project: project.id, subject: 'S', points: { '1': 2 } });
  assert.equal(ok.status, 201);
  const created = ok.body;
  assert.ok(isRecord(created) && typeof created.id === 'number');
  const storyId = created.id;

  const task = await send(fake, token, 'POST', '/tasks', { project: project.id, userStoryId: storyId, subject: 'T' });
  assert.equal(task.status, 400);
  assert.deepEqual(Object.keys(task.body as object), ['userStoryId']);
  const badParent = await send(fake, token, 'POST', '/tasks', { project: project.id, user_story: 999999, subject: 'T' });
  assert.equal(badParent.status, 400);
  assert.equal(fake.state.tasks.length, 0);
});

test('fake Taiga enforces OCC versions on PATCH and unique epic ↔ story links', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const token = await login(fake);
  const epic = fake.addEpic({ project: project.id, subject: 'E' });
  const story = fake.addUserStory({ project: project.id, subject: 'S' });

  assert.deepEqual(await send(fake, token, 'PATCH', `/userstories/${story.id}`, { subject: 'No version' }), {
    status: 400,
    body: { version: 'The version parameter is not valid' },
  });
  fake.editItem(story, { subject: 'Edited' });
  assert.deepEqual(await send(fake, token, 'PATCH', `/userstories/${story.id}`, { subject: 'Stale', version: 1 }), {
    status: 400,
    body: { version: "The version doesn't match with the current one" },
  });
  const merged = await send(fake, token, 'PATCH', `/userstories/${story.id}`, { description: 'Other field', version: 1 });
  assert.equal(merged.status, 200, 'a stale version is accepted when other fields changed meanwhile');
  assert.deepEqual([story.subject, story.description, story.version], ['Edited', 'Other field', 3]);

  const link = { epic: epic.id, user_story: story.id };
  assert.equal((await send(fake, token, 'POST', `/epics/${epic.id}/related_userstories`, link)).status, 201);
  assert.deepEqual(await send(fake, token, 'POST', `/epics/${epic.id}/related_userstories`, link), {
    status: 400,
    body: { non_field_errors: ['The fields user_story, epic must make a unique set.'] },
  });
  assert.equal(fake.state.epicRelatedUserStories.length, 1);
});

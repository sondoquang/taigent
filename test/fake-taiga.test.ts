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

test('fake Taiga keeps custom attribute values per item: string id keys, full replacement, own OCC version', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const other = fake.addProject({ slug: 'other' });
  const token = await login(fake);
  const estimate = fake.addCustomAttribute({ itemType: 'task', project: project.id, name: 'Estimate' });
  const owner = fake.addCustomAttribute({ itemType: 'task', project: project.id, name: 'Owner' });
  const storyAttribute = fake.addCustomAttribute({ itemType: 'userstory', project: project.id, name: 'Due' });
  const foreign = fake.addCustomAttribute({ itemType: 'task', project: other.id, name: 'Estimate' });
  const task = fake.addTask({ project: project.id, subject: 'T' });
  const path = `/tasks/custom-attributes-values/${task.id}`;

  const read = await fetch(`${fake.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await read.json(), { attributes_values: {}, version: 1, task: task.id }, 'created with the task');

  const id = (attribute: { id: number }) => String(attribute.id);
  assert.deepEqual(await send(fake, token, 'PATCH', path, { attributes_values: { [id(estimate)]: 3 } }), {
    status: 400,
    body: { version: 'The version parameter is not valid' },
  });
  for (const wrong of [storyAttribute, foreign]) {
    assert.deepEqual(await send(fake, token, 'PATCH', path, { attributes_values: { [id(wrong)]: 3 }, version: 1 }), {
      status: 400,
      body: { attributes_values: ['It contain invalid custom fields.'] },
    });
  }
  assert.equal((await send(fake, token, 'PATCH', path, { values: {}, version: 1 })).status, 400, 'unknown fields are rejected');

  const ok = await send(fake, token, 'PATCH', path, { attributes_values: { [id(estimate)]: 3, [id(owner)]: 'bob' }, version: 1 });
  assert.deepEqual(ok, { status: 200, body: { attributes_values: { [id(estimate)]: 3, [id(owner)]: 'bob' }, version: 2, task: task.id } });
  const replaced = await send(fake, token, 'PATCH', path, { attributes_values: { [id(owner)]: 'eve' }, version: 2 });
  assert.deepEqual(replaced.body, { attributes_values: { [id(owner)]: 'eve' }, version: 3, task: task.id }, 'PATCH replaces all values');
  assert.deepEqual(await send(fake, token, 'PATCH', path, { attributes_values: {}, version: 2 }), {
    status: 400,
    body: { version: "The version doesn't match with the current one" },
  });
});

test('fake Taiga filters the epic, user story and task lists by tags= like taiga-back (any listed tag, exact match)', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const token = await login(fake);
  const story = fake.addUserStory({ project: project.id, subject: 'Story A', tags: ['src:a', 'area:auth'] });
  fake.addUserStory({ project: project.id, subject: 'Story B', tags: ['src:b'] });
  fake.addUserStory({ project: project.id, subject: 'Story C', tags: ['src:c'] });
  fake.addEpic({ project: project.id, subject: 'Epic A', tags: ['SRC:A'] });
  fake.addEpic({ project: project.id, subject: 'Epic B', tags: ['src:b'] });
  fake.addEpic({ project: project.id, subject: 'Epic C', tags: ['src:c'] });
  fake.addTask({ project: project.id, user_story: story.id, subject: 'Task A', tags: ['src:a'] });
  fake.addTask({ project: project.id, user_story: story.id, subject: 'Task B', tags: ['src:b'] });
  fake.addTask({ project: project.id, user_story: story.id, subject: 'Task C' });

  const list = async (path: string, tags: string) => {
    const response = await fetch(`${fake.url}${path}?project=${project.id}&tags=${tags}`, {
      headers: { authorization: `Bearer ${token}`, 'x-disable-pagination': 'True' },
    });
    return ((await response.json()) as { subject: string }[]).map((item) => item.subject);
  };
  for (const [path, kind] of [['/epics', 'Epic'], ['/userstories', 'Story'], ['/tasks', 'Task']] as const) {
    assert.deepEqual(await list(path, 'src:a,src:b'), [`${kind} A`, `${kind} B`], `${path}: any listed tag`);
    assert.deepEqual(await list(path, 'SRC:A'), [], `${path}: tags are matched exactly (stored lowercased)`);
  }
});

async function postAttachment(fake: FakeTaiga, token: string, path: string, form: FormData | string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (typeof form === 'string') headers['content-type'] = 'application/json';
  const response = await fetch(`${fake.url}${path}`, { method: 'POST', headers, body: form });
  return { status: response.status, body: await response.json() };
}

test('fake Taiga parses multipart attachment uploads, computes size/sha1 from the bytes and rejects bad fields like Taiga', async (t) => {
  const fake = await startFakeTaiga();
  t.after(() => fake.close());
  const project = fake.addProject({ slug: 'demo' });
  const other = fake.addProject({ slug: 'other' });
  const story = fake.addUserStory({ project: project.id, subject: 'Story' });
  const token = await login(fake);
  const form = (fields: Record<string, string>, file = true) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    if (file) data.set('attached_file', new Blob([Buffer.from('hello\n')]), 'notes.txt');
    return data;
  };

  assert.deepEqual(await postAttachment(fake, token, '/userstories/attachments', JSON.stringify({ object_id: story.id, project: project.id })), {
    status: 400,
    body: { attached_file: ['No file was submitted.'] },
  });
  assert.deepEqual(await postAttachment(fake, token, '/userstories/attachments', form({ object_id: String(story.id), project_id: String(project.id) })), {
    status: 400,
    body: { project_id: ['Unknown field (the fake Taiga rejects unknown fields).'], project: ['This field is required.'] },
  });
  const wrongProject = await postAttachment(fake, token, '/userstories/attachments', form({ object_id: String(story.id), project: String(other.id) }));
  assert.equal(wrongProject.status, 400);
  const wrongType = await postAttachment(fake, token, '/tasks/attachments', form({ object_id: String(story.id), project: String(project.id) }));
  assert.equal(wrongType.status, 400, 'object_id must be an object of the endpoint type');
  assert.equal(fake.state.attachments.length, 0);

  const ok = await postAttachment(fake, token, '/userstories/attachments', form({ object_id: String(story.id), project: String(project.id), description: 'Notes' }));
  assert.equal(ok.status, 201);
  assert.ok(isRecord(ok.body));
  // `printf 'hello\n' | sha1sum`
  assert.deepEqual(
    { name: ok.body.name, size: ok.body.size, sha1: ok.body.sha1, object_id: ok.body.object_id, description: ok.body.description },
    { name: 'notes.txt', size: 6, sha1: 'f572d396fae9206628714fb2ce00f72e94f2258f', object_id: story.id, description: 'Notes' },
  );
  assert.equal(ok.body.content, undefined, 'stored bytes are not part of the attachment object');
});

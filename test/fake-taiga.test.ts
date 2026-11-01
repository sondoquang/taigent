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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { Preview } from '../src/review.ts';
import { type Harness, OFFLINE, startHarness } from './support/harness.ts';

const BACKLOG = `epics:
  - key: AUTH
    subject: Authentication
    tags: [type:feature]
    stories:
      - key: AUTH-LOGIN
        subject: Log in with email
        description: As a user I want to log in.
        acceptance_criteria:
          - Wrong password shows an error
`;

const ISSUES = `issues:
  - key: BUG-LONG-PASSWORD
    subject: Login fails with a 100-character password
    description: The form spins forever.
    type: Bug
    severity: Critical
    priority: High
`;

async function review(h: Harness, ...args: string[]) {
  return h.taigent(['review', ...args], { env: OFFLINE });
}

async function preview(h: Harness): Promise<Preview> {
  const result = await h.taigent(['preview', '--project', 'demo', '--json'], { env: OFFLINE });
  assert.equal(result.code, 0, result.stderr);
  return result.json<Preview>();
}

async function reviewFile(h: Harness): Promise<string> {
  return readFile(join(h.manifestsDir, 'demo', 'review.yaml'), 'utf8');
}

const login = (p: Preview) => p.epics[0]!.stories[0]!;

test('review approve records the item\'s current digest; editing the item makes the verdict stale', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const result = await review(h, 'approve', '--project', 'demo', 'AUTH-LOGIN', '--json');

  assert.equal(result.code, 0, result.stderr);
  const before = await preview(h);
  assert.equal(login(before).review.verdict, 'approved');
  assert.equal(login(before).review.stale, false);
  assert.equal(before.summary.approved, 1);
  assert.equal(result.json<{ key: string; digest: string }>().digest, login(before).digest);
  // No reviewer is recorded: review.yaml has no `by`.
  const item = parse(await reviewFile(h)).items['AUTH-LOGIN'];
  assert.deepEqual(Object.keys(item), ['verdict', 'digest', 'at']);

  await h.writeManifest('demo', 'backlog.yaml', BACKLOG.replace('Wrong password shows an error', 'Wrong password is rejected'));
  const after = await preview(h);
  assert.equal(login(after).review.stale, true);
  assert.equal(after.summary.approved, 0);
  assert.equal(after.summary.stale, 1);
  const page = await h.taigent(['preview', '--project', 'demo'], { env: OFFLINE });
  assert.match(page.stdout, /\*\*Review:\*\* approved on .* \(stale: the item changed since, review it again\)/);
  assert.deepEqual(h.fake.requests, []);
});

test('review request-changes, comment and resolve write verdicts and comments that validate accepts', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG + ISSUES);

  const changes = await review(h, 'request-changes', '--project', 'demo', 'AUTH-LOGIN', '--', 'Thiếu kịch bản lỗi', 'khi khoá tài khoản.');
  assert.equal(changes.code, 0, changes.stderr);
  const bare = await review(h, 'request-changes', '--project', 'demo', 'AUTH');
  assert.equal(bare.code, 0, bare.stderr);
  const comment = await review(h, 'comment', '--project', 'demo', 'AUTH-LOGIN', '--json', '--', 'Which error codes?');
  assert.equal(comment.code, 0, comment.stderr);
  assert.equal(comment.json<{ comment: { id: string } }>().comment.id, 'c2');
  const issue = await review(h, 'comment', '--project', 'demo', 'BUG-LONG-PASSWORD', '--', 'Which browsers?');
  assert.equal(issue.code, 0, issue.stderr);

  let p = await preview(h);
  assert.equal(login(p).review.verdict, 'changes');
  assert.equal(p.epics[0]!.review.verdict, 'changes');
  assert.deepEqual(p.epics[0]!.review.comments, []);
  assert.deepEqual(
    login(p).review.comments.map(({ id, text, resolved }) => [id, text, resolved]),
    [
      ['c1', 'Thiếu kịch bản lỗi khi khoá tài khoản.', false],
      ['c2', 'Which error codes?', false],
    ],
  );
  assert.equal(p.issues[0]!.review.verdict, undefined);
  assert.equal(p.issues[0]!.review.openComments, 1);
  assert.equal(p.summary.openComments, 3);

  const resolved = await review(h, 'resolve', '--project', 'demo', 'AUTH-LOGIN', 'c1', '--', 'Đã thêm kịch bản khoá tài khoản.');
  assert.equal(resolved.code, 0, resolved.stderr);
  p = await preview(h);
  assert.equal(login(p).review.verdict, 'changes');
  assert.deepEqual(login(p).review.comments.map(({ id, resolved, reply }) => [id, resolved, reply]), [
    ['c1', true, 'Đã thêm kịch bản khoá tài khoản.'],
    ['c2', false, undefined],
  ]);
  assert.equal(p.summary.openComments, 2);

  const valid = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });
  assert.equal(valid.code, 0, valid.stderr);
  assert.deepEqual(h.fake.requests, []);
});

test('review of a key not in the backlog, or of an unknown comment, exits 2 and writes nothing', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  const unknown = await review(h, 'approve', '--project', 'demo', 'AUTH-LOGOUT', '--json');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /AUTH-LOGOUT/);
  await assert.rejects(reviewFile(h), { code: 'ENOENT' });

  assert.equal((await review(h, 'comment', '--project', 'demo', 'AUTH', '--', 'Rename?')).code, 0);
  const written = await reviewFile(h);
  const missing = await review(h, 'resolve', '--project', 'demo', 'AUTH', 'c9', '--', 'Done.');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /c9/);
  assert.equal((await review(h, 'comment', '--project', 'demo', 'AUTH-LOGOUT', '--', 'Hm')).code, 2);
  assert.equal(await reviewFile(h), written);
});

test('review rejects a missing or unknown subcommand, key or text as usage errors', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);

  for (const args of [
    [],
    ['merge', '--project', 'demo', 'AUTH'],
    ['approve', '--project', 'demo'],
    ['approve', '--project', 'demo', 'auth'],
    ['approve', '--project', 'demo', 'AUTH', '--', 'looks good'],
    ['approve', 'AUTH'],
    ['comment', '--project', 'demo', 'AUTH'],
    ['resolve', '--project', 'demo', 'AUTH', 'c1'],
    ['resolve', '--project', 'demo', 'AUTH'],
  ]) {
    const result = await review(h, ...args);
    assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
  }
  await assert.rejects(reviewFile(h), { code: 'ENOENT' });
});

test('review of an invalid manifest exits 4 like preview', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG.replace('key: AUTH-LOGIN', 'key: auth-login'));

  const result = await review(h, 'approve', '--project', 'demo', 'AUTH', '--json');

  assert.equal(result.code, 4, result.stderr);
  await assert.rejects(reviewFile(h), { code: 'ENOENT' });
});

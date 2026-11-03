import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ManifestIssue } from '../src/manifest/errors.ts';
import {
  addComment,
  buildPreview,
  itemDigest,
  loadReview,
  type Preview,
  REVIEW_FILE,
  type Review,
  rekeyReview,
  rekeyReviewFile,
  saveReview,
  setVerdict,
} from '../src/review.ts';
import { startHarness } from './support/harness.ts';

/** No Taiga connection at all: preview and validate must work offline, without any TAIGA_* variable. */
const OFFLINE = { TAIGA_API_URL: undefined, TAIGA_USERNAME: undefined, TAIGA_PASSWORD: undefined };

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
        tasks:
          - key: AUTH-LOGIN-API
            subject: Login endpoint
`;

const ISSUES = `issues:
  - key: BUG-LONG-PASSWORD
    subject: Login fails with a 100-character password
    description: The form spins forever.
    type: Bug
    severity: Critical
    priority: High
    tags: [area:auth]
`;

const AT = '2026-11-02T09:30:00.000Z';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'taigent-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function preview(dir: string, files: Record<string, string>): Promise<Preview> {
  for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
  return buildPreview(dir, 'demo');
}

const story = (p: Preview) => p.epics[0]!.stories[0]!;

test('the digest follows what apply writes: subject, description, acceptance criteria, tags, attributes, parent', async (t) => {
  const dir = await tempDir(t);
  const base = story(await preview(dir, { 'backlog.yaml': BACKLOG }));
  const variants = [
    BACKLOG.replace('Log in with email', 'Log in with e-mail'),
    BACKLOG.replace('As a user I want to log in.', 'As a user I want to sign in.'),
    BACKLOG.replace('Wrong password shows an error', 'Wrong password shows a message'),
    BACKLOG.replace('        tasks:', '        spec: docs/auth.md\n        tasks:'),
    BACKLOG.replace('subject: Log in with email', 'subject: Log in with email\n        tags: [area:auth]'),
    BACKLOG.replace('subject: Log in with email', 'subject: Log in with email\n        custom_attributes: { Points: 3 }'),
  ];
  for (const variant of variants) {
    assert.notEqual(story(await preview(dir, { 'backlog.yaml': variant })).digest, base.digest, variant);
  }
  assert.equal(base.digest, itemDigest(base));
  assert.notEqual(itemDigest({ ...base, parent: 'BILLING' }), base.digest);
  // Taiga keeps tags lowercased and unordered: neither changes what apply writes.
  assert.equal(itemDigest({ ...base, tags: ['type:feature', 'area:auth'] }), itemDigest({ ...base, tags: ['area:auth', 'type:feature'] }));
});

test('review.yaml never changes digests; an approval given on another digest is stale and not counted as approved', async (t) => {
  const dir = await tempDir(t);
  const before = await preview(dir, { 'backlog.yaml': BACKLOG });
  const login = story(before);
  let review = setVerdict({ items: {} }, 'AUTH-LOGIN', 'approved', login.digest, 'Lan', AT);
  review = setVerdict(review, 'AUTH', 'changes', before.epics[0]!.digest, 'Lan', AT);
  review = addComment(review, 'AUTH-LOGIN-API', 'Which error codes?', 'Lan', AT);
  await saveReview(join(dir, REVIEW_FILE), review);

  const reviewed = await buildPreview(dir, 'demo');
  assert.equal(story(reviewed).digest, login.digest);
  assert.deepEqual(story(reviewed).review, { verdict: 'approved', stale: false, by: 'Lan', at: AT, comments: [], openComments: 0 });
  assert.deepEqual(
    { ...reviewed.summary },
    { epics: 1, stories: 1, tasks: 1, issues: 0, new: 3, applied: 0, approved: 1, changes: 1, unreviewed: 1, stale: 0, openComments: 1, unknownReviewKeys: [] },
  );

  const changed = await preview(dir, { 'backlog.yaml': BACKLOG.replace('Wrong password shows an error', 'Wrong password is rejected') });
  assert.equal(story(changed).review.verdict, 'approved');
  assert.equal(story(changed).review.stale, true);
  assert.equal(changed.summary.approved, 0);
  assert.equal(changed.summary.stale, 1);
});

test('addComment gives unique ids within an item, also after a comment was removed', () => {
  let review: Review = { items: {} };
  review = addComment(review, 'AUTH', 'first', 'Lan', AT);
  review = addComment(review, 'AUTH', 'second', 'Lan', AT);
  review = { items: { AUTH: { comments: review.items.AUTH!.comments.filter((c) => c.id !== 'c1') } } };
  review = addComment(review, 'AUTH', 'third', 'Lan', AT);
  review = addComment(review, 'BILLING', 'other item', 'Lan', AT);
  assert.deepEqual(review.items.AUTH!.comments.map((c) => c.id), ['c2', 'c3']);
  assert.deepEqual(review.items.BILLING!.comments.map((c) => [c.id, c.resolved]), [['c1', false]]);
});

test('saveReview round-trips through loadReview and drops items with neither verdict nor comment', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, REVIEW_FILE);
  let review = setVerdict({ items: {} }, 'AUTH-LOGIN', 'approved', 'abc', 'Lan', AT);
  review = addComment(review, 'AUTH', 'Line one\nline two: "quoted"', 'Minh', AT);
  review.items.AUTH!.comments[0] = { ...review.items.AUTH!.comments[0]!, resolved: true, reply: 'Đã sửa mô tả.' };
  review = setVerdict(review, 'BILLING', 'changes', 'def', 'Lan', AT);
  review = setVerdict(review, 'BILLING', undefined, '', 'Lan', AT);
  await saveReview(path, review);

  const loaded = await loadReview(path);
  assert.deepEqual(loaded, {
    items: {
      AUTH: { comments: [{ id: 'c1', by: 'Minh', at: AT, text: 'Line one\nline two: "quoted"', resolved: true, reply: 'Đã sửa mô tả.' }] },
      'AUTH-LOGIN': { verdict: 'approved', digest: 'abc', by: 'Lan', at: AT, comments: [] },
    },
  });
  await saveReview(path, loaded);
  const text = await readFile(path, 'utf8');
  assert.ok(!text.includes('BILLING'));
  assert.ok(text.indexOf('AUTH:') < text.indexOf('AUTH-LOGIN:'));
  assert.deepEqual(await loadReview(join(dir, 'missing.yaml')), { items: {} });
});

test('rekeyReview moves the comments of a re-keyed item but drops its verdict, and drops removed items', () => {
  let review = setVerdict({ items: {} }, 'AUTH-LOGIN', 'approved', 'abc', 'Lan', AT);
  review = addComment(review, 'AUTH-LOGIN', 'Thiếu tiêu chí', 'Minh', AT);
  review = setVerdict(review, 'AUTH-LOGIN-API', 'approved', 'def', 'Lan', AT);
  review = setVerdict(review, 'AUTH', 'approved', 'ghi', 'Lan', AT);
  review = setVerdict(review, 'BILLING', 'approved', 'jkl', 'Lan', AT);

  const next = rekeyReview(review, { 'AUTH-LOGIN': 'AUTH-SIGNIN', 'AUTH-LOGIN-API': 'AUTH-SIGNIN-API', AUTH: undefined });
  assert.deepEqual(next, {
    items: {
      'AUTH-SIGNIN': { comments: [{ id: 'c1', by: 'Minh', at: AT, text: 'Thiếu tiêu chí', resolved: false }] },
      BILLING: { verdict: 'approved', digest: 'jkl', by: 'Lan', at: AT, comments: [] },
    },
  });
  assert.ok(review.items['AUTH-LOGIN'], 'the input review is not changed');
  assert.equal(rekeyReview(review, { OTHER: 'OTHER-2', GONE: undefined }), review, 'no matching key: same review');
});

test('rekeyReviewFile saves review.yaml only when a key it names changed', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, REVIEW_FILE);
  assert.equal(await rekeyReviewFile(dir, { 'AUTH-LOGIN': 'AUTH-SIGNIN' }), false);
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' }, 'no review.yaml is created');

  const written = `# Review của PO\nitems:\n  AUTH-LOGIN:\n    verdict: approved\n    digest: abc\n`;
  await writeFile(path, written);
  assert.equal(await rekeyReviewFile(dir, { AUTH: 'AUTH-2', 'AUTH-LOGIN-API': undefined }), false);
  assert.equal(await readFile(path, 'utf8'), written, 'unchanged review is not rewritten');

  await writeFile(path, `items:\n  AUTH-LOGIN:\n    verdict: approved\n    digest: abc\n    comments:\n      - { id: c1, by: Minh, at: "${AT}", text: Rõ hơn, resolved: false }\n`);
  assert.equal(await rekeyReviewFile(dir, { 'AUTH-LOGIN': 'AUTH-SIGNIN' }), true);
  assert.deepEqual(await loadReview(path), { items: { 'AUTH-SIGNIN': { comments: [{ id: 'c1', by: 'Minh', at: AT, text: 'Rõ hơn', resolved: false }] } } });

  assert.equal(await rekeyReviewFile(dir, { 'AUTH-SIGNIN': undefined }), true);
  assert.deepEqual(await loadReview(path), { items: {} });
});

test('buildPreview marks the items recorded in state.json as applied', async (t) => {
  const dir = await tempDir(t);
  const state = { project: { id: 7, slug: 'demo' }, items: { AUTH: { type: 'epic', id: 18, ref: 38, version: 1 } } };
  const p = await preview(dir, { 'backlog.yaml': BACKLOG, 'state.json': JSON.stringify(state) });
  assert.deepEqual(p.epics[0]!.applied, { id: 18, ref: 38 });
  assert.equal(story(p).applied, undefined);
  assert.equal(p.summary.applied, 1);
  assert.equal(p.summary.new, 2);
});

test('issues are reviewed like other items: verdict, comments, counted, and stale once edited', async (t) => {
  const dir = await tempDir(t);
  const before = await preview(dir, { 'backlog.yaml': BACKLOG + ISSUES });
  assert.equal(before.issues.length, 1);
  const bug = before.issues[0]!;
  assert.deepEqual(
    { type: bug.type, key: bug.key, values: bug.values, parent: bug.parent },
    { type: 'issue', key: 'BUG-LONG-PASSWORD', values: { type: 'Bug', severity: 'Critical', priority: 'High' }, parent: undefined },
  );
  let review = setVerdict({ items: {} }, bug.key, 'approved', bug.digest, 'Lan', AT);
  review = addComment(review, bug.key, 'Which browsers?', 'Lan', AT);
  await saveReview(join(dir, REVIEW_FILE), review);

  const reviewed = await buildPreview(dir, 'demo');
  assert.equal(reviewed.issues[0]!.review.verdict, 'approved');
  assert.equal(reviewed.issues[0]!.review.stale, false);
  assert.equal(reviewed.issues[0]!.review.openComments, 1);
  assert.deepEqual(
    { ...reviewed.summary },
    { epics: 1, stories: 1, tasks: 1, issues: 1, new: 4, applied: 0, approved: 1, changes: 0, unreviewed: 3, stale: 0, openComments: 1, unknownReviewKeys: [] },
  );

  // Apply writes the type, severity and priority too: changing one makes the approval stale.
  for (const variant of [ISSUES.replace('Critical', 'Minor'), ISSUES.replace('type: Bug', 'type: Question'), ISSUES.replace('High', 'Low'), ISSUES.replace('forever', 'for ever')]) {
    const changed = await preview(dir, { 'backlog.yaml': BACKLOG + variant });
    assert.equal(changed.issues[0]!.review.stale, true, variant);
    assert.equal(changed.summary.stale, 1);
    assert.equal(changed.summary.approved, 0);
  }
});

test('validate accepts review.yaml entries for issues', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG + ISSUES);
  await h.writeManifest('demo', REVIEW_FILE, 'items:\n  BUG-LONG-PASSWORD:\n    verdict: approved\n    digest: abc\n');
  const ok = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });
  assert.equal(ok.code, 0, ok.stderr);
});

test('preview shows issues with their type, severity and priority', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG + ISSUES);
  await h.writeManifest('demo', REVIEW_FILE, `items:\n  BUG-LONG-PASSWORD:\n    comments:\n      - { id: c1, by: Lan, at: "${AT}", text: Which browsers? }\n`);

  const result = await h.taigent(['preview', '--project', 'demo', '--json'], { env: OFFLINE });
  assert.equal(result.code, 0, result.stderr);
  const p = result.json<Preview>();
  assert.equal(p.summary.issues, 1);
  assert.deepEqual(p.issues.map((i) => [i.key, i.values, i.review.openComments]), [['BUG-LONG-PASSWORD', { type: 'Bug', severity: 'Critical', priority: 'High' }, 1]]);

  const page = await h.taigent(['preview', '--project', 'demo'], { env: OFFLINE });
  assert.equal(page.code, 0, page.stderr);
  assert.match(page.stdout, /\| Issues \| 1 \|/);
  assert.match(page.stdout, /^## Issues$/m);
  assert.match(page.stdout, /^### Issue BUG-LONG-PASSWORD: Login fails with a 100-character password$/m);
  assert.match(page.stdout, /type: Bug · severity: Critical · priority: High/);
  assert.match(page.stdout, /Which browsers\?/);
  assert.deepEqual(h.fake.requests, []);
});

test('validate checks review.yaml: unknown keys and malformed reviews are issues', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  await h.writeManifest(
    'demo',
    REVIEW_FILE,
    `items:
  AUTH-LOGIN:
    verdict: approved
    digest: abc
  GONE:
    comments:
      - { id: c1, by: Lan, at: "${AT}", text: Still needed? }
  AUTH:
    verdict: maybe
    comments:
      - { id: c1, by: Lan, at: yesterday, text: "" }
      - { id: c1, by: Lan, at: "${AT}", text: again }
`,
  );

  const result = await h.taigent(['validate', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 4, result.stderr);
  const { error } = result.json<{ error: { issues: ManifestIssue[] } }>();
  assert.deepEqual(
    error.issues.map((i) => [i.path, i.rule]),
    [
      ['items.GONE', 'key-reference'],
      ['items.AUTH.verdict', 'review-verdict'],
      ['items.AUTH.digest', 'required'],
      ['items.AUTH.comments[0].at', 'type'],
      ['items.AUTH.comments[0].text', 'required'],
      ['items.AUTH.comments[1].id', 'review-comment-unique'],
    ],
  );

  await h.writeManifest('demo', REVIEW_FILE, 'items:\n  AUTH-LOGIN:\n    verdict: approved\n    digest: abc\n');
  const ok = await h.taigent(['validate', '--project', 'demo'], { env: OFFLINE });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /taiga[\\/]demo[\\/]review\.yaml: ok/);
});

test('preview --json and --out work offline, without Taiga env vars', async (t) => {
  const h = await startHarness(t);
  await h.writeManifest('demo', 'backlog.yaml', BACKLOG);
  await h.writeManifest('demo', REVIEW_FILE, `items:\n  AUTH:\n    comments:\n      - { id: c1, by: Lan, at: "${AT}", text: Rename? }\n`);

  const result = await h.taigent(['preview', '--project', 'demo', '--json'], { env: OFFLINE });

  assert.equal(result.code, 0, result.stderr);
  const p = result.json<Preview>();
  assert.equal(p.project.slug, 'demo');
  assert.equal(p.summary.openComments, 1);
  assert.match(story(p).description, /- \[ \] Wrong password shows an error/);
  assert.deepEqual(h.fake.requests, []);

  const page = await h.taigent(['preview', '--project', 'demo', '--out', 'out/preview.md'], { env: OFFLINE });
  assert.equal(page.code, 0, page.stderr);
  assert.match(await readFile(join(h.cwd, 'out', 'preview.md'), 'utf8'), /^# /);
  assert.deepEqual(h.fake.requests, []);
});

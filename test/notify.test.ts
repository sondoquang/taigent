import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { FakeTaiga, FakeUserStory } from './support/fake-taiga.ts';
import { type Harness, startHarness } from './support/harness.ts';

// UTC+7 without daylight saving, so "today" is the same calendar day for the CLI and for the test.
const TZ = 'Asia/Ho_Chi_Minh';
const TOKEN = '123456:telegram-bot-token-secret';

/** A Telegram Bot API stand-in: records every request and answers `ok`, or `reply` when set. */
async function startFakeTelegram(t: TestContext) {
  const requests: { path: string; body: { chat_id: string; text: string } }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, result: {} } };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    refuse(status: number, description: string) {
      reply = { status, body: { ok: false, error_code: status, description } };
    },
  };
}

/** YYYY-MM-DD `offset` days from today in TZ (for runs without TAIGENT_NOW). */
function dayIn(offset: number): string {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return date.toISOString().slice(0, 10);
}

// Thursday 2026-11-19, 10:00 local time: the week is 16/11 – 22/11 and the plan starts today.
const NOW = '2026-11-19T10:00:00+07:00';

type StoryFields = Partial<Pick<FakeUserStory, 'is_closed' | 'finish_date' | 'due_date' | 'status_name' | 'total_points'>> & { assigned?: number[] };

/**
 * The plan puts on 19/11 overdue (2h), dueToday (3h) and startToday (3h of 10h, latest start day 19/11), on 20/11
 * the rest of startToday (7h) and noDueDate is out of it. overdue is At risk: planned to finish 19/11, due 18/11.
 */
function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other] });
  const story = (subject: string, { assigned = [me], ...fields }: StoryFields) =>
    Object.assign(fake.addUserStory({ project: alpha.id, subject }), { assigned_users: assigned, is_closed: fields.finish_date != null, ...fields });
  return {
    overdue: story('overdue', { due_date: '2026-11-18', status_name: 'Ready', total_points: 2 }),
    dueToday: story('due today', { due_date: '2026-11-19', status_name: 'In progress', total_points: 3 }),
    startToday: story('start today', { due_date: '2026-11-20', status_name: 'Ready', total_points: 10 }),
    noPoints: story('no points', { due_date: '2026-12-31', status_name: 'Ready' }),
    noDueDate: story('no due date', { status_name: 'In progress', total_points: 4 }),
    waitingForQa: story('waiting for QA', { due_date: '2026-11-19', status_name: 'Ready for test', total_points: 1 }),
    closedToday: story('closed today', { due_date: '2026-11-19', finish_date: '2026-11-19T01:00:00Z', total_points: 1 }),
    someoneElses: story('not mine', { assigned: [other], due_date: '2026-11-19', status_name: 'In progress', total_points: 1 }),
  };
}

/** The plugin's state directory with its bot token and the paired users, as /telegram:configure and pairing leave it. */
async function pluginState(h: Harness, allowFrom: string[]): Promise<string> {
  const dir = join(h.cwd, 'telegram-state');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
  await writeFile(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom, groups: {} }));
  return dir;
}

test('notify eod sends your unfinished planned tickets due by today with their re-plan to the paired chat', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  const tickets = seed(h.fake);
  const stateDir = await pluginState(h, ['412587349']);

  const result = await h.taigent(['notify', 'eod'], { env: { TZ, TAIGENT_NOW: NOW, TELEGRAM_STATE_DIR: stateDir, TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Sent the eod message to Telegram chat 412587349\n');
  assert.equal(telegram.requests.length, 1);
  const [request] = telegram.requests;
  assert.equal(request!.path, `/bot${TOKEN}/sendMessage`);
  assert.equal(request!.body.chat_id, '412587349');
  const [head, replan, hint] = request!.body.text.split('\n\n');
  assert.equal(head, [
    '⏰ Cuối ngày 19/11/2026: bạn còn 2 ticket đến hạn hôm nay hoặc trước đó mà chưa xong.',
    `• #${tickets.overdue.ref} overdue — Ready · Overdue · hạn 18/11 (alpha)`,
    `• #${tickets.dueToday.ref} due today — In progress · Due today · hạn 19/11 (alpha)`,
  ].join('\n'));
  assert.match(replan!, new RegExp(`^Đề xuất dời hạn \\(re-plan\\):\\n• #${tickets.overdue.ref} overdue: 18/11 → 19/11 — .+$`));
  assert.equal(hint, 'Xong rồi thì nhắn "đóng hết" hoặc "đóng #<số>" để chuyển sang Ready for test (chờ QA/QC); đồng ý dời hạn thì nhắn "duyệt re-plan".');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
});

test('notify eod sends nothing when no unfinished planned ticket is due by today', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  const tickets = seed(h.fake);
  tickets.overdue.status_name = 'Ready for test';
  tickets.dueToday.status_name = 'Ready for test';
  const stateDir = await pluginState(h, ['412587349']);

  const result = await h.taigent(['notify', 'eod'], { env: { TZ, TAIGENT_NOW: NOW, TELEGRAM_STATE_DIR: stateDir, TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Nothing to send: no unfinished planned ticket is due by 2026-11-19\n');
  assert.deepEqual(telegram.requests, []);
});

test('notify week --dry-run prints the whole plan and every warning without any Telegram setup', async (t) => {
  const h = await startHarness(t);
  const tickets = seed(h.fake);

  const result = await h.taigent(['notify', 'week', '--dry-run', '--json'], { env: { TZ, TAIGENT_NOW: NOW, TELEGRAM_STATE_DIR: join(h.cwd, 'nothing-here') } });

  assert.equal(result.code, 0, result.stderr);
  const out = result.json<{ kind: string; range: { from: string; to: string }; text: string; sent: boolean; chatId: null }>();
  assert.equal(out.sent, false);
  assert.equal(out.chatId, null);
  assert.deepEqual(out.range, { from: '2026-11-16', to: '2026-11-22' });
  const [o, d, s, p, n] = [tickets.overdue, tickets.dueToday, tickets.startToday, tickets.noPoints, tickets.noDueDate].map((story) => story.ref);
  assert.deepEqual(out.text.split('\n\n'), [
    '📅 Tuần 16/11 – 22/11/2026 · taigent-bot\nChưa xong 5 ticket (Ready 3, In progress 2), chờ test 1, đã Done 1.',
    `Kế hoạch (từ 19/11):\n• T5 19/11 — 8h: #${o} (2h), #${d} (3h), #${s} (3h)\n• T6 20/11 — 7h: #${s} (7h)`,
    `Quá hạn (1):\n• #${o} overdue — Ready · Overdue · hạn 18/11 (alpha)`,
    `Chưa có hạn (1):\n• #${n} no due date — In progress · No due date · chưa có hạn (alpha)`,
    `Chưa có point (1):\n• #${p} no points — Ready · On track · hạn 31/12 (alpha)`,
    `Đã tới ngày phải bắt đầu mà còn Ready (2):\n• #${o} overdue — Ready · Overdue · hạn 18/11 (alpha) · bắt đầu muộn nhất 18/11\n• #${s} start today — Ready · On track · hạn 20/11 (alpha) · bắt đầu muộn nhất 19/11`,
    `Có nguy cơ trễ hạn (1):\n• #${o} overdue — Ready · Overdue · hạn 18/11 (alpha) · dự kiến xong 19/11, chung ngày với #${d}, #${s}`,
  ]);
});

test('notify day lists the plan of today, what must start today, what is due today and what is overdue', async (t) => {
  const h = await startHarness(t);
  const tickets = seed(h.fake);

  const result = await h.taigent(['notify', 'day', '--dry-run'], { env: { TZ, TAIGENT_NOW: NOW } });

  assert.equal(result.code, 0, result.stderr);
  const [o, d, s] = [tickets.overdue, tickets.dueToday, tickets.startToday].map((story) => story.ref);
  assert.deepEqual(result.stdout.split('\n\n'), [
    '☀️ Hôm nay T5 19/11/2026 · taigent-bot',
    `Kế hoạch hôm nay (8h):\n• #${o} overdue — 2h (alpha)\n• #${d} due today — 3h (alpha)\n• #${s} start today — 3h (alpha)`,
    `Phải bắt đầu hôm nay (2):\n• #${s} start today — Ready · On track · hạn 20/11 (alpha)\n• #${d} due today — In progress · Due today · hạn 19/11 (alpha)`,
    `Đến hạn hôm nay (1):\n• #${d} due today — In progress · Due today · hạn 19/11 (alpha)`,
    `Quá hạn (1):\n• #${o} overdue — Ready · Overdue · hạn 18/11 (alpha)\n`,
  ]);
});

test('notify splits a message longer than Telegram allows at line breaks', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  const alpha = h.fake.addProject({ slug: 'alpha' });
  for (let i = 0; i < 60; i += 1) {
    Object.assign(h.fake.addUserStory({ project: alpha.id, subject: `story ${i} ${'x'.repeat(100)}` }), { assigned_users: [h.fake.user.id], due_date: dayIn(-1), status_name: 'Ready' });
  }

  const result = await h.taigent(['notify', 'eod'], { env: { TZ, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(telegram.requests.length >= 2, `${telegram.requests.length} messages`);
  const texts = telegram.requests.map((request) => request.body.text);
  for (const text of texts) assert.ok(text.length <= 4096, `${text.length} characters`);
  const lines = texts.join('\n').split('\n');
  for (let i = 0; i < 60; i += 1) assert.equal(lines.filter((line) => line.includes(`story ${i} x`)).length, 1, `story ${i}`);
});

test('notify without a bot token or with several paired users is a usage error before Taiga is contacted', async (t) => {
  const h = await startHarness(t);
  const stateDir = await pluginState(h, ['111', '222']);

  const noToken = await h.taigent(['notify', 'day'], { env: { TELEGRAM_STATE_DIR: join(h.cwd, 'empty') } });
  const twoUsers = await h.taigent(['notify', 'day'], { env: { TELEGRAM_STATE_DIR: stateDir } });
  const badKind = await h.taigent(['notify', 'month']);

  assert.equal(noToken.code, 2);
  assert.match(noToken.stderr, /no Telegram bot token: set TELEGRAM_BOT_TOKEN, or run \/telegram:configure/);
  assert.equal(twoUsers.code, 2);
  assert.match(twoUsers.stderr, /2 paired Telegram users in .*access\.json: set TELEGRAM_CHAT_ID/);
  assert.equal(badKind.code, 2);
  assert.match(badKind.stderr, /notify needs one of: week, day, eod/);
  assert.deepEqual(h.fake.requests, []);
});

test('a message Telegram refuses is exit 5 with its reason, and the bot token never shows', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  seed(h.fake);
  telegram.refuse(400, 'Bad Request: chat not found');

  const result = await h.taigent(['notify', 'day', '--json'], { env: { TZ, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42', TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 5);
  assert.deepEqual(result.json<{ error: { kind: string } }>().error.kind, 'telegram');
  assert.match(result.stderr, /Telegram refused the message to chat 42: HTTP 400: Bad Request: chat not found/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
});

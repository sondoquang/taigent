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

/** YYYY-MM-DD `offset` days from today in TZ. */
function dayIn(offset: number): string {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return date.toISOString().slice(0, 10);
}

/** `dd/mm` of a YYYY-MM-DD day, as the messages print it. */
const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

type StoryFields = Partial<Pick<FakeUserStory, 'is_closed' | 'finish_date' | 'due_date' | 'status_name'>> & { assigned?: number[] };

function seed(fake: FakeTaiga) {
  const me = fake.user.id;
  const other = fake.addUser({ username: 'other' }).id;
  const alpha = fake.addProject({ slug: 'alpha', name: 'Alpha', members: [me, other] });
  const story = (subject: string, { assigned = [me], ...fields }: StoryFields) =>
    Object.assign(fake.addUserStory({ project: alpha.id, subject }), { assigned_users: assigned, is_closed: fields.finish_date != null, ...fields });
  return {
    dueToday: story('due today', { due_date: dayIn(0), status_name: 'In progress' }),
    overdue: story('overdue', { due_date: dayIn(-3), status_name: 'Ready' }),
    dueLater: story('due later', { due_date: dayIn(30) }),
    noDueDate: story('no due date', {}),
    closedToday: story('closed today', { due_date: dayIn(0), finish_date: new Date().toISOString() }),
    someoneElses: story('not mine', { assigned: [other], due_date: dayIn(0) }),
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

test('notify eod sends your open tickets due by today to the paired chat, with the bot of the Telegram plugin', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  const tickets = seed(h.fake);
  const stateDir = await pluginState(h, ['412587349']);

  const result = await h.taigent(['notify', 'eod'], { env: { TZ, TELEGRAM_STATE_DIR: stateDir, TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Sent the eod message to Telegram chat 412587349\n');
  assert.equal(telegram.requests.length, 1);
  const [request] = telegram.requests;
  assert.equal(request!.path, `/bot${TOKEN}/sendMessage`);
  assert.equal(request!.body.chat_id, '412587349');
  const text = request!.body.text;
  assert.match(text, /bạn còn 2 ticket đến hạn chưa đóng/);
  assert.ok(text.includes(`#${tickets.overdue.ref} overdue — Ready · hạn ${shortDay(dayIn(-3))} (alpha)`), text);
  assert.ok(text.includes(`#${tickets.dueToday.ref} due today — In progress · hạn ${shortDay(dayIn(0))} (alpha)`), text);
  for (const left of [tickets.dueLater, tickets.noDueDate, tickets.closedToday, tickets.someoneElses]) assert.ok(!text.includes(left.subject), left.subject);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(TOKEN));
});

test('notify eod sends nothing when no open ticket is due by today', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  h.fake.addProject({ slug: 'alpha' });
  const stateDir = await pluginState(h, ['412587349']);

  const result = await h.taigent(['notify', 'eod'], { env: { TZ, TELEGRAM_STATE_DIR: stateDir, TAIGENT_TELEGRAM_API_URL: telegram.url } });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `Nothing to send: no open ticket is due by ${dayIn(0)}\n`);
  assert.deepEqual(telegram.requests, []);
});

test('notify week --dry-run prints the week by due status without any Telegram setup', async (t) => {
  const h = await startHarness(t);
  const tickets = seed(h.fake);

  const result = await h.taigent(['notify', 'week', '--dry-run', '--json'], { env: { TZ, TELEGRAM_STATE_DIR: join(h.cwd, 'nothing-here') } });

  assert.equal(result.code, 0, result.stderr);
  const out = result.json<{ kind: string; range: { from: string; to: string }; text: string; sent: boolean; chatId: null }>();
  assert.equal(out.sent, false);
  assert.equal(out.chatId, null);
  // Monday to Sunday around today.
  assert.equal(new Date(`${out.range.from}T00:00:00Z`).getUTCDay(), 1);
  assert.equal(new Date(`${out.range.to}T00:00:00Z`).getUTCDay(), 0);
  assert.ok(out.range.from <= dayIn(0) && dayIn(0) <= out.range.to);
  const sections = out.text.split('\n\n');
  const sectionOf = (title: string) => sections.find((section) => section.startsWith(`${title} (`)) ?? '';
  assert.match(sectionOf('Quá hạn'), new RegExp(`#${tickets.overdue.ref} overdue`));
  assert.match(sectionOf('Đến hạn trong tuần'), new RegExp(`#${tickets.dueToday.ref} due today`));
  assert.match(sectionOf('Hạn sau tuần này'), new RegExp(`#${tickets.dueLater.ref} due later`));
  assert.match(sectionOf('Chưa có hạn'), new RegExp(`#${tickets.noDueDate.ref} no due date`));
  assert.match(sectionOf('Đã đóng trong tuần'), new RegExp(`#${tickets.closedToday.ref} closed today`));
  assert.ok(!out.text.includes('not mine'));
});

test('notify day lists what is due today and overdue, and counts the other open tickets', async (t) => {
  const h = await startHarness(t);
  const tickets = seed(h.fake);

  const result = await h.taigent(['notify', 'day', '--dry-run'], { env: { TZ } });

  assert.equal(result.code, 0, result.stderr);
  const sections = result.stdout.split('\n\n');
  assert.match(sections.find((s) => s.startsWith('Đến hạn hôm nay (1):')) ?? '', new RegExp(`#${tickets.dueToday.ref} due today`));
  assert.match(sections.find((s) => s.startsWith('Quá hạn (1):')) ?? '', new RegExp(`#${tickets.overdue.ref} overdue`));
  assert.match(result.stdout, /Còn mở khác: 2 ticket\.\n$/);
});

test('notify splits a message longer than Telegram allows at line breaks', async (t) => {
  const h = await startHarness(t);
  const telegram = await startFakeTelegram(t);
  const alpha = h.fake.addProject({ slug: 'alpha' });
  for (let i = 0; i < 60; i += 1) {
    Object.assign(h.fake.addUserStory({ project: alpha.id, subject: `story ${i} ${'x'.repeat(100)}` }), { assigned_users: [h.fake.user.id], due_date: dayIn(-1) });
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

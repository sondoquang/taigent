// Smoke step of Taiga > Ticket của tôi (spec #35, ticket #47), run by smoke.mjs while the Taiga section is shown.
//   1. With the user's own login (read-only): the panel opens on this week, Monday to Sunday, and "‹ Tuần trước"
//      reads the previous week. Without a login it shows the Vietnamese error with its fix, and the period still changes.
//   2. Against FakeTaiga (test/support/fake-taiga.ts), never the real Taiga: the app's process env points the CLI at
//      the fake for this step only. A cancelled confirmation writes nothing; a status change and a comment are written
//      and the list is read again; a conflict, a ticket no longer yours and a refused login show their Vietnamese
//      message with the fix. The env and the "Huỷ" dialog stub are restored afterwards.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeTaiga } from '../../test/support/fake-taiga.ts';

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Monday to Sunday of the local week holding `day`, `weeks` weeks later. */
function weekOf(day, weeks = 0) {
  const monday = new Date(day.getFullYear(), day.getMonth(), day.getDate() - ((day.getDay() + 6) % 7) + 7 * weeks);
  return `${dayOf(monday)}..${dayOf(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))}`;
}

const TAIGA_VARS = ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGA_TOKEN', 'TAIGENT_CONFIG_DIR', 'TAIGENT_CREDENTIAL_STORE'];

export async function smokeTickets({ app, page, work, shots, check, log, login }) {
  const thisWeek = weekOf(new Date());
  const lastWeek = weekOf(new Date(), -1);
  const period = () => page.getAttribute('#tickets-list', 'data-period');
  /** Waits until the list shows `expected` (a `from..to`) or a failure; returns the failure text, if any. */
  const settled = async (expected) => {
    await page.waitForFunction(
      (want) => {
        const list = document.querySelector('#tickets-list');
        return list?.dataset.period === want || Boolean(list?.querySelector('.failure'));
      },
      expected,
      { timeout: 120_000 },
    );
    return (await page.locator('#tickets-list .failure').count()) > 0 ? ((await page.textContent('#tickets-list .failure')) ?? '') : undefined;
  };

  check(`${await page.inputValue('#tickets-from')}..${await page.inputValue('#tickets-to')}` === thisWeek, `tickets: the period defaults to this week, ${thisWeek}`);
  const first = await settled(thisWeek);
  if (login.loggedIn) {
    check(first === undefined, `tickets: read this week's tickets with your login (${first ?? (await page.textContent('#tickets-summary'))?.trim() ?? 'không có ticket'})`);
    await page.screenshot({ path: join(shots, 'tickets-1-this-week.png') });
    await page.click('#tickets-prev');
    check((await settled(lastWeek)) === undefined && (await period()) === lastWeek, `tickets: "Tuần trước" read ${lastWeek}`);
    await page.screenshot({ path: join(shots, 'tickets-2-last-week.png') });
  } else {
    check(Boolean(first?.includes('Chưa đăng nhập') && first.includes('Cách sửa')), 'tickets: without a login, the panel says so in Vietnamese with the fix');
    await page.click('#tickets-prev');
    await settled(lastWeek);
    check(`${await page.inputValue('#tickets-from')}..${await page.inputValue('#tickets-to')}` === lastWeek, `tickets: "Tuần trước" moved the period to ${lastWeek}`);
    log('skipped reading real tickets: not logged in');
  }

  // FakeTaiga: two tickets of the fake user this week, and a teammate.
  const fake = await startFakeTaiga();
  const configDir = await mkdtemp(join(work, 'fake-config-'));
  try {
    const me = fake.user.id;
    const other = fake.addUser({ username: 'teammate' }).id;
    const project = fake.addProject({ slug: 'smoke-tickets', name: 'Smoke - Tickets', members: [me, other] });
    const today = new Date();
    const yesterday = dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));
    const tomorrow = dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
    const open = Object.assign(fake.addUserStory({ project: project.id, subject: 'Màn hình Ticket của tôi' }), {
      assigned_users: [me],
      status_name: 'In progress',
      due_date: yesterday,
      total_points: 3,
    });
    const closed = Object.assign(fake.addUserStory({ project: project.id, subject: 'Đã xong trong tuần' }), {
      assigned_users: [me],
      status_name: 'Done',
      is_closed: true,
      finish_date: new Date().toISOString(),
      due_date: tomorrow,
    });
    const row = (story) => `#tickets-list tr[data-ticket="smoke-tickets#${story.ref}"]`;
    const patches = () => fake.requests.filter((request) => request.method === 'PATCH').length;
    const answer = (response) =>
      app.evaluate(({ dialog }, value) => {
        globalThis.smokeDialogs = [];
        dialog.showMessageBox = async (_window, options) => {
          globalThis.smokeDialogs.push(options.title);
          return { response: value, checkboxChecked: false };
        };
      }, response);
    const setEnv = (values) =>
      app.evaluate((_electron, entries) => {
        for (const [name, value] of entries) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }, Object.entries(values));
    /** Clicks `selector`, then waits for the list to be read again (it shows `period` once more). */
    const clickAndReread = async (selector) => {
      await page.evaluate(() => document.querySelector('#tickets-list')?.removeAttribute('data-period'));
      await page.click(selector);
      await page.waitForSelector(`#tickets-list[data-period="${thisWeek}"], #tickets-list .failure`, { timeout: 60_000 });
    };
    const writeResult = async () => (await page.textContent('#tickets-result'))?.trim() ?? '';

    const saved = await app.evaluate((_electron, names) => Object.fromEntries(names.map((name) => [name, process.env[name]])), TAIGA_VARS);
    await setEnv({
      TAIGA_API_URL: fake.url,
      TAIGA_USERNAME: fake.user.username,
      TAIGA_PASSWORD: fake.user.password,
      TAIGA_TOKEN: undefined,
      TAIGENT_CONFIG_DIR: configDir,
      TAIGENT_CREDENTIAL_STORE: 'file',
    });
    try {
      await page.click('#tickets-this-week');
      await page.waitForSelector(row(open), { timeout: 60_000 });
      check((await period()) === thisWeek, 'tickets (FakeTaiga): "Tuần này" reads this week again');
      check((await page.textContent('#tickets-summary'))?.startsWith('2 ticket'), 'tickets (FakeTaiga): two tickets listed');
      const openRow = await page.textContent(row(open));
      check(openRow?.includes('Quá hạn') && openRow.includes('3h (ước tính từ points)'), 'tickets (FakeTaiga): the open ticket is Quá hạn with its effort from points');
      check((await page.textContent(row(closed)))?.includes('Đúng hạn'), 'tickets (FakeTaiga): the closed ticket is Đúng hạn');
      const options = await page.locator(`${row(open)} select.ticket-status option`).evaluateAll((items) => items.map((item) => item.value));
      check(options.join('|') === 'New|Ready|In progress|Ready for test|Done|Archived', `tickets (FakeTaiga): the status dropdown lists the project's statuses (${options.join(', ')})`);
      await page.screenshot({ path: join(shots, 'tickets-3-fake.png') });

      // "Huỷ" in the confirmation writes nothing.
      await answer(1);
      await page.selectOption(`${row(open)} select.ticket-status`, 'Ready for test');
      await page.click(`${row(open)} .ticket-status-save`);
      await page.waitForFunction(() => document.querySelector('[data-sonner-toaster]')?.textContent?.includes('Đã huỷ'));
      check(patches() === 0 && (await app.evaluate(() => globalThis.smokeDialogs)).includes('Đổi status ticket'), 'tickets (FakeTaiga): status change asked for confirmation; "Huỷ" wrote nothing');

      // Confirmed: the status is written, then the list is read again.
      await answer(0);
      await page.selectOption(`${row(open)} select.ticket-status`, 'Ready for test');
      await clickAndReread(`${row(open)} .ticket-status-save`);
      check((await writeResult()).includes('In progress → Ready for test') && open.status_name === 'Ready for test', 'tickets (FakeTaiga): status written through taigent status');
      check((await page.inputValue(`${row(open)} select.ticket-status`)) === 'Ready for test', 'tickets (FakeTaiga): the list was read again after the status change');

      const text = `Smoke: đã xong phần dropdown (${new Date().toISOString()})\n- còn phần comment`;
      await page.click(`${row(open)} .ticket-comment-open`);
      await page.fill('tr[data-comment] textarea.ticket-comment-text', text);
      await clickAndReread('tr[data-comment] .ticket-comment-send');
      check((await writeResult()).includes('Đã gửi comment') && fake.state.comments.some((comment) => comment.item === open.id && comment.comment === text), 'tickets (FakeTaiga): comment written through taigent comment, line break kept');
      check((await page.locator('tr[data-comment]').count()) === 0, 'tickets (FakeTaiga): the list was read again and the comment box closed');
      await page.screenshot({ path: join(shots, 'tickets-4-written.png') });

      // Someone changes the ticket between the read and the write: a conflict, nothing written, the list read again.
      // Taiga's OCC rejects a PATCH only when a field it sends was changed meanwhile: here `status`.
      const ready = fake.state.storyStatuses.find((status) => status.project === project.id && status.name === 'Ready');
      fake.onRequest({ method: 'GET', path: '/userstory-statuses', run: () => fake.editItem(open, { status: ready.id, status_name: 'Ready' }) });
      await page.selectOption(`${row(open)} select.ticket-status`, 'Done');
      await clickAndReread(`${row(open)} .ticket-status-save`);
      const conflict = await writeResult();
      check(conflict.includes('vừa được đổi trên Taiga') && conflict.includes('Cách sửa') && open.status_name === 'Ready', 'tickets (FakeTaiga): a conflict says so in Vietnamese with the fix; nothing written');
      check((await page.inputValue(`${row(open)} select.ticket-status`)) === 'Ready', 'tickets (FakeTaiga): the list shows the status set meanwhile');

      // The ticket was given to someone else meanwhile: refused, nothing written, gone from the list once read again.
      open.assigned_users = [other];
      await page.selectOption(`${row(open)} select.ticket-status`, 'Done');
      await clickAndReread(`${row(open)} .ticket-status-save`);
      const notMine = await writeResult();
      check(notMine.includes('không phải ticket của bạn') && notMine.includes('Cách sửa') && open.status_name === 'Ready', 'tickets (FakeTaiga): a ticket no longer yours is refused in Vietnamese with the fix');
      check((await page.locator(row(open)).count()) === 0, 'tickets (FakeTaiga): the list no longer shows it');
      await page.screenshot({ path: join(shots, 'tickets-5-errors.png') });

      // A login Taiga refuses (an expired one looks the same to the app).
      await setEnv({ TAIGA_PASSWORD: 'wrong-password' });
      await clickAndReread('#tickets-refresh');
      const refused = (await page.textContent('#tickets-list .failure')) ?? '';
      check(refused.includes('hết hạn hoặc bị từ chối') && refused.includes('Cách sửa'), 'tickets (FakeTaiga): a refused login says so in Vietnamese with the fix');
    } finally {
      await setEnv(saved);
      await answer(1);
    }
  } finally {
    await fake.close();
  }
}

// Smoke step of the Dashboard (spec #64 Seam 3, ticket #70), run by smoke.mjs right after the repository opens, while
// the Dashboard is the shown section. Against FakeTaiga (test/support/fake-taiga.ts) only, never the real Taiga: the
// app's process env points the CLI at the fake (through a gate that can hold a read in flight) for this step, then is
// restored; the app opens again so that its whoami knows the fake's login, whose API URL keys the saved read.
//   1. Without a Role the three choices sit in the page; the one picked is saved in settings.json.
//   2. The Developer dashboard shows the fake project's numbers, cycle time from the items' history (kept in the app's
//      metrics-cache by --cache-dir), the bug reopen rate from the issues' history, and "Chỉ tôi" narrows the workload
//      and the lists to the user.
//   3. The Role menu switches to the Product Owner dashboard (smoke-dashboard-po.mjs) and the Business Analyst
//      dashboard (smoke-dashboard-ba.mjs); Settings shows the Role and changes it too.
//   4. Làm mới reads again: the numbers follow what Taiga holds.
//   5. A reload (the app opened again) keeps the Role and shows the saved numbers with their time while the next read
//      runs (held by the gate); the saved read lacks cycle time, as one an older taigent wrote: its cells say "Chưa
//      có". That read failing, and then a login Taiga refuses, show the Vietnamese error with its fix while the
//      numbers stay.
//   6. A saved read in an older build's format (the bare report, without the Product Owner and Business Analyst
//      sections) is ignored: the Product Owner dashboard shows the next read instead of breaking.

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { startFakeTaiga } from '../../test/support/fake-taiga.ts';
import { smokeBusinessAnalyst } from './smoke-dashboard-ba.mjs';
import { smokeProductOwner } from './smoke-dashboard-po.mjs';
import { at, day } from './smoke-days.mjs';

const TAIGA_VARS = ['TAIGA_API_URL', 'TAIGA_USERNAME', 'TAIGA_PASSWORD', 'TAIGA_TOKEN', 'TAIGENT_CONFIG_DIR', 'TAIGENT_CREDENTIAL_STORE'];

/**
 * A proxy in front of the fake Taiga that can hold a read in flight. `hold()` leaves every request unanswered but the
 * login's (POST /auth, GET /users/me: whoami still answers); `release()` drops those and refuses the next ones the same
 * way, until `open()` lets everything through again.
 */
async function startGate(fake) {
  const target = new URL(fake.url);
  const held = new Set();
  let mode = 'open';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', target);
    const login = url.pathname.endsWith('/auth') || url.pathname.endsWith('/users/me');
    if (mode !== 'open' && !login) {
      if (mode === 'hold') held.add(request.socket);
      else request.socket.destroy();
      return;
    }
    const upstream = httpRequest(url, { method: request.method, headers: request.headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}${target.pathname}`,
    hold: () => {
      mode = 'hold';
    },
    release: () => {
      mode = 'drop';
      for (const socket of held) socket.destroy();
      held.clear();
    },
    open: () => {
      mode = 'open';
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

/** The fake project: the current sprint and the one before, work of the fake user and a teammate, and three bugs. */
function seed(fake, slug) {
  const me = fake.user.id;
  const lan = fake.addUser({ username: 'lan' }).id;
  const project = fake.addProject({ slug, name: 'Smoke - Dashboard', members: [me, lan] });
  fake.addMilestone({ project: project.id, name: 'Sprint 1', estimated_start: day(-20), estimated_finish: day(-7), closed: true });
  fake.addMilestone({ project: project.id, name: 'Sprint 2', estimated_start: day(-6), estimated_finish: day(7) });
  const status = (list, name) => {
    const found = list.find((candidate) => candidate.project === project.id && candidate.name === name);
    return { status: found.id, status_name: found.name, is_closed: found.is_closed };
  };
  const story = (subject, { name = 'New', assigned = [], created, closed, due, blocked = false, points = null }) =>
    Object.assign(fake.addUserStory({ project: project.id, subject }), {
      ...status(fake.state.storyStatuses, name),
      assigned_users: assigned,
      assigned_to: assigned[0] ?? null,
      created_date: at(created),
      finish_date: closed === undefined ? null : at(closed),
      due_date: due === undefined ? null : day(due),
      is_blocked: blocked,
      total_points: points,
    });
  const task = (subject, { name = 'New', assignee = null, created, closed, due }) =>
    Object.assign(fake.addTask({ project: project.id, subject }), {
      ...status(fake.state.taskStatuses, name),
      assigned_to: assignee,
      created_date: at(created),
      finished_date: closed === undefined ? null : at(closed),
      due_date: due === undefined ? null : day(due),
    });
  const bug = (subject, { name, assignee, created, closed }) => {
    const type = fake.state.issueTypes.find((value) => value.project === project.id && value.name === 'Bug').id;
    const found = fake.state.issueStatuses.find((value) => value.project === project.id && value.name === name);
    return Object.assign(fake.addIssue({ project: project.id, subject, type, status: found.id }), {
      is_closed: found.is_closed,
      assigned_to: assignee,
      created_date: at(created),
      finished_date: at(closed),
    });
  };
  const sso = story('Đăng nhập SSO', { name: 'In progress', assigned: [me], created: -10, due: -1, blocked: true, points: 3 });
  const profile = story('Trang hồ sơ', { assigned: [lan], created: -5, points: 5 });
  const changed = story('Đổi mật khẩu', { name: 'Done', assigned: [me], created: -8, closed: -2, points: 2 });
  fake.addStatusChange(changed, { at: at(-6), from: 'New', to: 'In progress' });
  fake.addStatusChange(changed, { at: at(-2), from: 'In progress', to: 'Done' });
  story('Chưa ai nhận', { created: -3, points: 8 });
  const migrate = task('Migrate bảng user', { name: 'In progress', assignee: lan, created: -4, due: -2 });
  const test = task('Viết test SSO', { name: 'Closed', assignee: me, created: -3, closed: -1 });
  fake.addStatusChange(test, { at: at(-2), from: 'New', to: 'In progress' });
  fake.addStatusChange(test, { at: at(-1), from: 'In progress', to: 'Closed' });
  bug('Crash khi đăng nhập', { name: 'Closed', assignee: me, created: -5, closed: -2 });
  bug('Không tái hiện được', { name: 'Rejected', assignee: lan, created: -3, closed: -1 });
  // Resolved, reopened and closed again in the current sprint: 2 bugs resolved, 1 reopened, none open at its end.
  const reopened = bug('Mất ảnh đại diện', { name: 'Closed', assignee: me, created: -6, closed: -1 });
  fake.addStatusChange(reopened, { at: at(-5), from: 'New', to: 'Ready for test' });
  fake.addStatusChange(reopened, { at: at(-4), from: 'Ready for test', to: 'In progress' });
  fake.addStatusChange(reopened, { at: at(-1), from: 'In progress', to: 'Closed' });
  return { me, lan, project, sso, profile, migrate, done: status(fake.state.storyStatuses, 'Done') };
}

export async function smokeDashboard({ app, page, work, project, shots, check, log, goTo }) {
  const settingsFile = join(work, 'user-data', 'settings.json');
  const metricsDir = join(work, 'user-data', 'metrics-cache');
  const reads = async () => Number(await page.getAttribute('#dashboard', 'data-reads'));
  /** Waits until `count` reads have finished this session and none runs. */
  const readsDone = (count) =>
    page.waitForFunction(
      (want) => {
        const dashboard = document.querySelector('#dashboard');
        return dashboard?.dataset.state === 'idle' && Number(dashboard.dataset.reads) >= want;
      },
      count,
      { timeout: 120_000 },
    );
  /** Clicks Làm mới and waits for that read to finish. */
  const refresh = async () => {
    const before = await reads();
    await page.click('#dashboard-refresh');
    await readsDone(before + 1);
  };
  const generatedAt = () => page.getAttribute('#dashboard-generated-at', 'data-generated-at');
  /** label → value of the stat cells under `selector`. */
  const stats = (selector) =>
    page.locator(`${selector} .stat`).evaluateAll((cells) => Object.fromEntries(cells.map((cell) => [cell.querySelector('span')?.textContent ?? '', cell.querySelector('strong')?.textContent ?? ''])));
  const rows = (selector, attribute) => page.locator(`${selector} tr[${attribute}]`).evaluateAll((items, name) => items.map((item) => item.getAttribute(name)), attribute);
  const failureText = async () => ((await page.locator('#dashboard-failure .failure').count()) > 0 ? ((await page.textContent('#dashboard-failure .failure')) ?? '') : '');
  const setEnv = (values) =>
    app.evaluate((_electron, entries) => {
      for (const [name, value] of entries) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }, Object.entries(values));

  // The read the opened repository started (the user's own login, or none) ends before the env changes.
  await readsDone(1);
  log('dashboard: first read with the app env:', (await failureText()).split('\n')[0] || 'ok');

  const fake = await startFakeTaiga();
  const gate = await startGate(fake);
  const configDir = await mkdtemp(join(work, 'dashboard-config-'));
  const saved = await app.evaluate((_electron, names) => Object.fromEntries(names.map((name) => [name, process.env[name]])), TAIGA_VARS);
  // The saved read of the project on the fake Taiga: keyed by the API URL of the login and the slug, like the CLI cache.
  const savedFile = join(metricsDir, `latest-${project}-${createHash('sha256').update(gate.url).digest('hex').slice(0, 16)}.json`);
  try {
    const { me, lan, sso, profile, migrate, done } = seed(fake, project);
    await setEnv({
      TAIGA_API_URL: gate.url,
      TAIGA_USERNAME: fake.user.username,
      TAIGA_PASSWORD: fake.user.password,
      TAIGA_TOKEN: undefined,
      TAIGENT_CONFIG_DIR: configDir,
      TAIGENT_CREDENTIAL_STORE: 'file',
    });
    // Opened again, the app's whoami reports the fake's login; the Dashboard reads with it.
    await page.reload();
    await readsDone(1);
    check((await failureText()) === '' && Boolean(await generatedAt()), `dashboard (FakeTaiga): opened with the fake's login, the Dashboard read the metrics of ${project}`);
    const savedRead = JSON.parse(await readFile(savedFile, 'utf8'));
    check(
      savedRead.version === 1 && savedRead.apiUrl === gate.url && savedRead.report.project.slug === project,
      'dashboard: the read is saved in user-data/metrics-cache for the next start, keyed by the API URL of the login and the project',
    );
    const cached = (await readdir(metricsDir)).filter((name) => name.startsWith(`history-${project}-`));
    check(cached.length > 0, `dashboard: taigent metrics keeps the items' history in user-data/metrics-cache (--cache-dir) (${cached.join(', ')})`);
    check(fake.requests.every((request) => request.method === 'GET' || request.path === '/auth'), 'dashboard: taigent metrics only reads Taiga');

    // 1. No Role yet: the three choices, in the page; the one picked is saved.
    check(await page.isVisible('#dashboard-role-choice') && !(await page.isVisible('#dashboard-developer')), 'dashboard: without a Role the numbers wait for the choice');
    await page.screenshot({ path: join(shots, 'dashboard-1-role-choice.png') });
    await page.click('#dashboard-role-choice button[data-role="developer"]');
    await page.waitForSelector('#dashboard-developer');
    check(JSON.parse(await readFile(settingsFile, 'utf8')).role === 'developer' && !(await page.isVisible('#dashboard-role-choice')), 'dashboard: Developer picked in the page and saved in settings.json');

    // 2. The Developer dashboard, for the team.
    const current = await stats('#dashboard-throughput');
    check(
      current['Story được giao'] === '3' && current['Story hoàn thành'] === '1' && current['Task được giao'] === '2' && current['Task hoàn thành'] === '1',
      `dashboard: the current sprint's stories and tasks, counted apart (${JSON.stringify(current)})`,
    );
    const bugs = await stats('#dashboard-bugs');
    check(bugs['Bug resolved trong kỳ'] === '2' && bugs['Bug bị Rejected trong kỳ'] === '1', `dashboard: bugs resolved and Rejected apart (${JSON.stringify(bugs)})`);
    const times = await stats('#dashboard-times');
    check(
      times['Cycle time story (trung vị của 1 item)'] === '4 ngày' && times['Cycle time task (trung vị của 1 item)'] === '1 ngày',
      `dashboard: cycle time from the first entry into In progress, stories and tasks apart (${JSON.stringify(times)})`,
    );
    check(
      bugs['Reopen rate (1 reopened / 2 resolved)'] === '50%' && (await page.getAttribute('#dashboard-bugs [data-metric="developer.bugs.reopenRate"]', 'data-value')) === '0.5',
      `dashboard: the reopen rate from the bugs' history, reopened over resolved (${JSON.stringify(bugs)})`,
    );
    check(await page.isVisible('#dashboard-trend [data-slot="chart"] .recharts-surface'), 'dashboard: the completion trend is a chart');
    const team = await rows('#dashboard-workload', 'data-assignee');
    check(team.join('|') === `${lan}|${me}|none`, `dashboard: workload of each assignee, then Chưa giao (${team.join(', ')})`);
    const overdue = await rows('#dashboard-overdue', 'data-item');
    check(overdue.join('|') === `task-${migrate.ref}|story-${sso.ref}`, `dashboard: overdue items, earliest first (${overdue.join(', ')})`);
    check((await rows('#dashboard-blocked', 'data-item')).join('|') === `story-${sso.ref}`, 'dashboard: the blocked story');
    await page.screenshot({ path: join(shots, 'dashboard-2-developer.png'), fullPage: true });

    // "Chỉ tôi": filtered here, without reading again.
    const before = await reads();
    await page.click('#dashboard-mine');
    await page.waitForSelector('#dashboard-developer[data-scope="mine"]');
    const mine = await rows('#dashboard-workload', 'data-assignee');
    check(mine.join('|') === String(me), `dashboard: "Chỉ tôi" keeps only the user's workload row (${mine.join(', ')})`);
    check((await rows('#dashboard-overdue', 'data-item')).join('|') === `story-${sso.ref}`, 'dashboard: "Chỉ tôi" narrows the overdue list');
    check((await stats('#dashboard-throughput'))['Story được giao'] === '2', 'dashboard: "Chỉ tôi" shows the user\'s own figures');
    check((await reads()) === before, 'dashboard: "Chỉ tôi" did not run the CLI again');
    await page.screenshot({ path: join(shots, 'dashboard-3-mine.png'), fullPage: true });
    await page.click('#dashboard-mine');

    // 3. The Role menu, and Settings.
    /** Opens the Role menu (once the previous one has closed: its items leave with an animation) and picks `role`. */
    const pickFromMenu = async (role) => {
      await page.waitForSelector('[role="menu"]', { state: 'detached' });
      await page.click('#dashboard-role-menu');
      await page.click(`[role="menu"][data-state="open"] [role="menuitemradio"][data-role="${role}"]`);
      await page.waitForSelector(`#dashboard[data-role="${role}"]`);
    };
    await pickFromMenu('productOwner');
    await smokeProductOwner({ app, page, fake, work, project, shots, check, log, refresh, setEnv });
    await pickFromMenu('businessAnalyst');
    await smokeBusinessAnalyst({ app, page, fake, work, project, shots, check, refresh, stats, setEnv, onTaiga: sso });
    check(JSON.parse(await readFile(settingsFile, 'utf8')).role === 'businessAnalyst', 'dashboard: the Role picked from the menu is saved');
    await goTo(page, 'settings');
    check(await page.isChecked('#settings-role [role="radio"][value="businessAnalyst"]'), 'Settings shows the Role picked on the Dashboard');
    await page.click('#settings-role [role="radio"][value="developer"]');
    await page.waitForSelector('#settings-role [role="radio"][value="developer"][aria-checked="true"]');
    await goTo(page, 'dashboard');
    await page.waitForSelector('#dashboard-developer');
    check(JSON.parse(await readFile(settingsFile, 'utf8')).role === 'developer', 'dashboard: the Role picked in Settings shows on the Dashboard and is saved');

    // 4. Làm mới follows Taiga: a story closed since.
    Object.assign(profile, { ...done, finish_date: new Date().toISOString() });
    const first = await generatedAt();
    await refresh();
    check((await stats('#dashboard-throughput'))['Story hoàn thành'] === '2' && (await generatedAt()) !== first, 'dashboard: Làm mới shows the story closed since, with the new time');
    const last = await generatedAt();

    // 5. Opened again: the Role and the saved numbers show while the next read runs; failed reads keep them. The saved
    // read loses its cycle time first, as a read an older taigent wrote: those cells say so instead of disappearing.
    const latest = JSON.parse(await readFile(savedFile, 'utf8'));
    delete latest.report.developer.cycleTime;
    await writeFile(savedFile, JSON.stringify(latest));
    gate.hold();
    await page.reload();
    await page.waitForSelector('#dashboard[data-state="loading"] #dashboard-developer', { timeout: 60_000 });
    check((await generatedAt()) === last && (await page.getAttribute('#dashboard-role-menu', 'data-role')) === 'developer', 'dashboard: opened again, the Role and the saved numbers show with their time while the read runs');
    check(((await page.textContent('#dashboard-generated-at')) ?? '').startsWith('Cập nhật lúc'), 'dashboard: the time of the saved numbers is shown');
    const cycleCells = await page.locator('#dashboard-times [data-metric^="developer.cycleTime."]').allTextContents();
    check(
      cycleCells.length === 2 && cycleCells.every((text) => text.includes('Chưa có') && text.includes('phiên bản taigent cũ')),
      `dashboard: a saved read without cycle time shows its cells as "Chưa có", with why (${cycleCells.join(' | ')})`,
    );
    await page.screenshot({ path: join(shots, 'dashboard-5-saved.png') });
    gate.release();
    await readsDone(1);
    const unreachable = await failureText();
    check(unreachable.includes('Không đọc được số liệu') && unreachable.includes('Cách sửa') && (await page.isVisible('#dashboard-developer')) && (await generatedAt()) === last, 'dashboard: a failed read says so in Vietnamese with the fix; the numbers stay');

    gate.open();
    await setEnv({ TAIGA_PASSWORD: 'wrong-password' });
    await refresh();
    const refused = await failureText();
    check(refused.includes('hết hạn hoặc bị từ chối') && refused.includes('Cách sửa') && (await page.isVisible('#dashboard-developer')) && (await generatedAt()) === last, 'dashboard: a refused login says so in Vietnamese with the fix; the numbers stay');
    await page.screenshot({ path: join(shots, 'dashboard-6-error.png') });

    // 6. A saved read in an older build's format, also under the name those builds used: the bare report, without the
    // Product Owner and Business Analyst sections. The Product Owner dashboard ignores it and shows the next read.
    await setEnv({ TAIGA_PASSWORD: fake.user.password });
    await pickFromMenu('productOwner');
    const { productOwner: _po, businessAnalyst: _ba, ...older } = latest.report;
    await writeFile(savedFile, JSON.stringify(older));
    await writeFile(join(metricsDir, `latest-${project}.json`), JSON.stringify(older));
    await page.reload();
    await readsDone(1);
    check(
      (await failureText()) === '' && (await page.isVisible('#dashboard-product-owner')) && (await generatedAt()) !== last,
      'dashboard: a saved read in an older format is ignored, and the Product Owner dashboard shows the next read',
    );
    check(JSON.parse(await readFile(savedFile, 'utf8')).version === 1, 'dashboard: the next read replaced the older saved read');
  } finally {
    await setEnv(saved);
    await gate.close();
    await fake.close();
  }
}

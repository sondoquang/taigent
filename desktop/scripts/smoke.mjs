// Smoke test of Taigent Desktop, driven with Playwright's Electron support. It never touches the user's manifests:
// it copies the committed fixture `scripts/fixture/smoke-taigent-desktop` (or `taiga/<slug>` of the repository with
// --project) to a temporary folder and points the app there with TAIGENT_MANIFESTS_DIR, and it uses a temporary
// user-data folder. It never writes to a real Taiga: every native confirm dialog (push, bootstrap, wiki upload) is
// stubbed to "Huỷ", "Xem thay đổi trên Taiga", bootstrap --dry-run, the Báo cáo report and Ticket của tôi (read-only)
// use the login only when the app reports one, and "Đẩy wiki lên Taiga" and Ticket của tôi's writes (status, comment)
// run against an in-process fake Taiga (test/support/fake-taiga.ts; smoke-tickets.mjs for the tickets).
// Terminal steps: scripts/smoke-terminal.mjs; Git: scripts/smoke-git.mjs; headless skill buttons (run-skill --dry-run,
// Huỷ): scripts/smoke-headless.mjs; setup wizard (last): scripts/smoke-wizard.mjs.
//
//   node scripts/smoke.mjs [--project <slug> --story <key>] [--exe <packaged app exe>] [--out <screenshot dir>]

import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { parse } from 'yaml';
import { agentPath, descendants, smokeTerminal, waitGone } from './smoke-terminal.mjs';
import { smokeGit } from './smoke-git.mjs';
import { smokeWizard } from './smoke-wizard.mjs';
import { headlessPath, smokeHeadless } from './smoke-headless.mjs';
import { smokeTickets } from './smoke-tickets.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    story: { type: 'string', default: 'REVIEW-COMMENT' },
    exe: { type: 'string' },
    out: { type: 'string', default: join(repo, 'tmp', 'desktop-smoke') },
  },
});
const project = values.project ?? 'smoke-taigent-desktop';
const source = values.project ? join(repo, 'taiga', project) : join(desktop, 'scripts', 'fixture', project);
const { story } = values;
const shots = resolve(values.out);
const work = await mkdtemp(join(tmpdir(), 'taigent-desktop-smoke-'));
const manifests = join(work, 'taiga');
await cp(source, join(manifests, project), { recursive: true });
const reviewFile = join(manifests, project, 'review.yaml');
const backlogFile = join(manifests, project, 'backlog.yaml');

const executablePath = values.exe ? resolve(values.exe) : createRequire(import.meta.url)('electron');
const app = await electron.launch({
  executablePath,
  // Playwright emulates a light `prefers-color-scheme` by default; the app's theme setting must drive it instead.
  colorScheme: null,
  args: [...(values.exe ? [] : [desktop]), `--user-data-dir=${join(work, 'user-data')}`],
  env: { ...process.env, TAIGENT_MANIFESTS_DIR: manifests, TAIGENT_RUN_SKILL_DRY_RUN: '1', PATH: await headlessPath(work, await agentPath(work)) },
  cwd: repo,
});
const log = (...parts) => console.log('[smoke]', ...parts);
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok -', message);
};
const SECTIONS = ['backlog', 'wiki', 'taiga', 'changes', 'git', 'setup', 'settings'];
/** Switches to a section of the navigation shell and checks that only its screen shows. */
const goTo = async (page, section) => {
  await page.click(`#nav [data-section="${section}"]`);
  await page.waitForSelector(`#screen-${section}`, { state: 'visible' });
  const shown = [];
  for (const name of SECTIONS) if (await page.isVisible(`#screen-${name}`)) shown.push(name);
  if (shown.length !== 1 || shown[0] !== section) throw new Error(`FAILED: section ${section} shows screens ${shown.join(', ')}`);
  if ((await page.getAttribute(`#nav [data-section="${section}"]`, 'aria-current')) !== 'page') throw new Error(`FAILED: nav does not mark ${section}`);
};

try {
  const versions = await app.evaluate(() => ({ electron: process.versions.electron, node: process.versions.node }));
  log('versions', JSON.stringify(versions));
  // The folder dialog and the push confirmations are native: answer them from the main process ("Huỷ" unless a step
  // sets smokeAnswer), recording what they showed.
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    globalThis.smokeDialogs = [];
    globalThis.smokeAnswer = 1;
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.smokeDialogs.push({ title: options.title, message: options.message, detail: options.detail });
      return { response: globalThis.smokeAnswer, checkboxChecked: false };
    };
  }, repo);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded');
  const sections = await page.locator('#nav [data-section]').evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()));
  check(sections.join('|') === 'Backlog|Wiki|Taiga|Thay đổi|Git|Setup repo|Settings', `navigation shows ${sections.join(', ')}`);
  check((await page.isVisible('#screen-backlog')) && !(await page.isVisible('#screen-changes')), 'the app opens on Backlog');
  await page.waitForSelector('#setup-banner[data-state="no-repo"]');
  log('ok - without a repository, the app points to Setup repo');

  await page.click('#open-repo');
  await page.waitForSelector('#tree .node');
  const select = await page.inputValue('#project-select');
  check(select === project, `project ${project} opened (select = ${select})`);
  const nodes = await page.locator('#tree .node').count();
  check(nodes > 10, `tree shows ${nodes} items`);
  await page.screenshot({ path: join(shots, '1-tree.png') });

  await page.click(`#tree .node[data-key="${story}"]`);
  await page.waitForSelector('.detail-head h1');
  check((await page.textContent('.breadcrumb'))?.includes(story), `story ${story} selected`);
  const checkboxes = await page.locator('.markdown li > input[type="checkbox"][disabled]').count();
  check(checkboxes > 0, `description shows ${checkboxes} acceptance criteria as disabled task-list checkboxes`);
  check((await page.locator('.block h3').allTextContents()).every((title) => !/Tiêu chí chấp nhận|^Spec$/i.test(title)), 'no separate acceptance criteria / spec sections');
  await page.screenshot({ path: join(shots, '2-story-detail.png') });

  const comment = `Smoke: làm rõ biến nào là bắt buộc (${new Date().toISOString()})`;
  await page.fill('#comment-text', comment);
  await page.click('#composer button[type="submit"]');
  await page.waitForSelector('.comment.open');
  await page.click('.verdict-bar [data-verdict="changes"]');
  await page.waitForSelector('.verdict-bar .verdict.changes.on');
  const afterChanges = await readFile(reviewFile, 'utf8');
  check(afterChanges.includes(story) && afterChanges.includes('verdict: changes') && afterChanges.includes('Smoke: làm rõ'), 'review.yaml has the comment and verdict changes');
  await page.screenshot({ path: join(shots, '3-changes-comment.png') });

  // Push is blocked while an item marked "Cần sửa" has open comments (the confirm dialog is stubbed to cancel).
  // Pushing lives in the "Thay đổi" section.
  await goTo(page, 'changes');
  await page.click('#apply-btn');
  await page.waitForSelector('#changes-result h2');
  const blocked = await page.textContent('#changes-result');
  check(blocked?.includes('Chưa thể đẩy lên Taiga') && blocked.includes(story), 'push blocked by the open comment');
  await page.screenshot({ path: join(shots, '4-push-blocked.png') });

  // Switching sections keeps the open project and the selected item.
  for (const section of ['settings']) {
    await goTo(page, section);
    await page.keyboard.press('j');
    await page.screenshot({ path: join(shots, `nav-${section}.png`) });
  }
  await goTo(page, 'backlog');
  check((await page.inputValue('#project-select')) === project, 'project still open after switching sections');
  check((await page.getAttribute('#tree .node.selected', 'data-key')) === story, `${story} still selected after switching sections (j ignored outside Backlog)`);
  check((await page.textContent('.breadcrumb'))?.includes(story), `detail still shows ${story}`);

  // Settings > Giao diện: Tối and Sáng switch the page (prefers-color-scheme through nativeTheme) and are saved.
  const paperOf = () => page.evaluate(() => ({ dark: matchMedia('(prefers-color-scheme: dark)').matches, paper: getComputedStyle(document.documentElement).backgroundColor }));
  const themeFile = join(work, 'user-data', 'settings.json');
  await goTo(page, 'settings');
  check(await page.isChecked('input[name="theme"][value="system"]'), 'Settings: the theme follows the system by default');
  await page.check('input[name="theme"][value="dark"]');
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = await paperOf();
  check(dark.paper === 'rgb(30, 30, 31)' && JSON.parse(await readFile(themeFile, 'utf8')).theme === 'dark', `Tối: the page turns dark and settings.json keeps it (${JSON.stringify(dark)})`);
  await goTo(page, 'backlog');
  await page.screenshot({ path: join(shots, 'theme-dark-backlog.png') });
  await goTo(page, 'settings');
  await page.screenshot({ path: join(shots, 'theme-dark-settings.png') });
  await page.check('input[name="theme"][value="light"]');
  await page.waitForFunction(() => !matchMedia('(prefers-color-scheme: dark)').matches);
  const light = await paperOf();
  check(light.paper === 'rgb(255, 255, 255)' && JSON.parse(await readFile(themeFile, 'utf8')).theme === 'light', `Sáng: the page turns light and settings.json keeps it (${JSON.stringify(light)})`);
  await page.check('input[name="theme"][value="system"]');
  await page.waitForFunction(() => document.querySelector('input[name="theme"][value="system"]')?.checked === true);
  await goTo(page, 'backlog');

  // Approve, then change the story's description as an agent would: the approval turns stale.
  await page.click('.verdict-bar [data-verdict="approved"]');
  await page.waitForSelector('.verdict-bar .verdict.approve.on, #toast.error');
  check(await page.isVisible('.verdict-bar .verdict.approve.on'), `the story is marked Đạt${(await page.isVisible('#toast.error')) ? ` (error: ${await page.textContent('#toast')})` : ''}`);
  check((await readFile(reviewFile, 'utf8')).includes('verdict: approved'), 'review.yaml has verdict approved');
  const backlog = await readFile(backlogFile, 'utf8');
  // A Windows checkout (core.autocrlf) has CRLF line endings.
  const at = backlog.search(new RegExp(`- key: ${story}\\r?\\n`));
  check(at !== -1, `backlog.yaml declares ${story}`);
  const descriptionAt = backlog.indexOf('description: "', at);
  await writeFile(backlogFile, `${backlog.slice(0, descriptionAt)}description: "[Agent đã sửa] ${backlog.slice(descriptionAt + 'description: "'.length)}`);
  await page.waitForSelector('.detail-head .badge.stale', { timeout: 10_000 });
  log('ok - detail shows "Đã đổi sau khi duyệt" after the description changed (live refresh)');
  await page.click('.filter[data-filter="stale"]');
  const staleNodes = await page.locator('#tree .node:not(.context)').count();
  check(staleNodes === 1, `filter "Đã đổi" shows ${staleNodes} item`);
  await page.screenshot({ path: join(shots, '5-stale.png') });
  await page.click('.filter[data-filter="all"]');

  // Keyboard navigation.
  await page.click('.detail-head h1');
  await page.keyboard.press('j');
  const next = await page.getAttribute('#tree .node.selected', 'data-key');
  check(next !== story, `j moves to the next item (${next})`);
  await page.keyboard.press('k');
  check((await page.getAttribute('#tree .node.selected', 'data-key')) === story, 'k moves back');

  // Issues sit in their own group after the epic tree and are reviewed like any item.
  const issue = 'BUG-STALE-AFTER-RENAME';
  if (!values.project) {
    check((await page.textContent('#tree .tree-group'))?.startsWith('Issues'), 'tree shows the Issues group');
    await page.click(`#tree .node[data-key="${issue}"]`);
    await page.waitForSelector('.issue-values');
    const classification = await page.textContent('.issue-values');
    check(classification?.includes('Bug') && classification.includes('Normal') && classification.includes('High'), `issue ${issue} shows type, severity and priority`);
    check((await page.textContent(`#tree .node[data-key="${issue}"] .badge.new`)) === 'Mới', `issue ${issue} is labelled Mới`);
    await page.click('.verdict-bar [data-verdict="approved"]');
    await page.waitForSelector(`#tree .node[data-key="${issue}"] .badge.approved`);
    const reviewed = await readFile(reviewFile, 'utf8');
    check(new RegExp(`${issue}:\\r?\\n\\s+verdict: approved`).test(reviewed), `review.yaml has verdict approved for issue ${issue}`);
    await page.screenshot({ path: join(shots, '5b-issue.png') });
  }

  if (values.project) log('skipped forms: they use the keys of the fixture');
  else {
    await formScenario(page);
    await storyFormScenario(page);
    await issueFormScenario(page);
    await wikiScenario(page);
    await snapshotBadgeScenario(page);
    await staleLinkScenario(page);
  }

  await smokeTerminal(page, { repo, shots, log, check });
  await smokeHeadless(page, { app, repo, project, work, shots, log, check, goTo });

  await page.waitForFunction(() => document.querySelector('#statusbar')?.textContent?.includes('Taiga'), null, { timeout: 30_000 }).catch(() => undefined);
  const login = await page.evaluate(() => window.taigent.whoami());
  log('login', JSON.stringify({ loggedIn: login.loggedIn, username: login.username, apiUrl: login.apiUrl, message: login.message }));
  if (login.loggedIn) {
    await goTo(page, 'changes');
    await page.click('#plan-btn');
    await page.waitForSelector('#changes-result h2', { timeout: 120_000 });
    log('plan result:', (await page.textContent('#changes-result h2'))?.trim());
    await page.screenshot({ path: join(shots, '9-plan.png') });
    await goTo(page, 'backlog');
    if (!values.project) await issueValuesOnTaiga(page);
  } else {
    log('skipped plan: not logged in');
  }

  // A project slug is checked where IPC enters the main process: a path never reaches a folder or a command.
  const refusals = await page.evaluate(() =>
    Promise.all([
      window.taigent.readWiki('../outside'),
      window.taigent.openProject('..'),
      window.taigent.readBacklog('taiga\\..\\..'),
      window.taigent.readTaigaReport('Upper'),
      window.taigent.saveProjectSettings({ slug: '../x', settings: {}, baseDigest: null }),
    ]),
  );
  check(refusals.every((result) => !result.ok && /không phải slug project/.test(result.message)), `bad slugs are refused at the IPC boundary (${refusals.map((result) => result.message).join(' | ')})`);

  // Taiga > Project: the fixture's manifest directory is listed (with the user's Taiga projects when logged in), its
  // project.yaml opens in the form and saves in place; bootstrap (logged in only) stops at the confirmation, "Huỷ".
  await app.evaluate(({ dialog }) => {
    globalThis.smokeDialogs = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.smokeDialogs.push(options.title);
      return { response: 1, checkboxChecked: false };
    };
  });
  await goTo(page, 'taiga');
  await page.waitForSelector(`#taiga-projects-list tr[data-slug="${project}"]`, { timeout: 60_000 });
  log('projects:', (await page.textContent('#taiga-projects-status'))?.trim());
  await page.click(`#taiga-projects-list [data-open="${project}"]`);
  await page.waitForSelector('#project-form');
  const projectFile = join(manifests, project, 'project.yaml');
  const projectYaml = await readFile(projectFile, 'utf8');
  const declaredName = /^name: (.+)$/m.exec(projectYaml)?.[1]?.trim();
  check((await page.inputValue('#pf-name')) === declaredName, `project form shows project.yaml's name (${declaredName})`);
  check((await page.textContent('#pf-slug')) === project, 'project form shows the slug');
  await page.screenshot({ path: join(shots, '10-project.png') });
  const description = `Smoke: mô tả sửa bằng form (${new Date().toISOString()})`;
  await page.fill('#pf-description', description);
  // Editing disables bootstrap until the form is saved; the form read back after the save enables it again.
  check((await page.getAttribute('#taiga-bootstrap', 'data-off')) === 'true', 'bootstrap waits for the edited form to be saved');
  await page.click('#pf-save');
  await page.waitForSelector('#taiga-bootstrap[data-off="false"]');
  check((await page.inputValue('#pf-description')) === description && !(await page.isVisible('#pf-issues')), 'form read back after the save, without issues');
  const savedYaml = await readFile(projectFile, 'utf8');
  check(savedYaml.includes(description) && savedYaml.includes('area:review') && savedYaml.includes('# Fixture of the desktop smoke'), 'project.yaml saved in place: description changed, comment and tags kept');
  if (login.loggedIn) {
    await page.click('#taiga-bootstrap');
    await page.waitForSelector('#taiga-bootstrap-result :is(p:not(.muted), .failure)', { timeout: 120_000 });
    const dialogs = await app.evaluate(() => globalThis.smokeDialogs);
    const result = (await page.textContent('#taiga-bootstrap-result'))?.trim();
    log('bootstrap result:', result);
    check(dialogs.includes('Bootstrap project') && result?.includes('Đã huỷ bootstrap'), 'bootstrap --dry-run asked for confirmation, answered "Huỷ"');
    await page.screenshot({ path: join(shots, '11-bootstrap-cancelled.png') });
  } else {
    log('skipped bootstrap: not logged in');
  }

  // Taiga > Báo cáo, below Project: its project choice lists the Taiga projects read above. Logged in, the first one's
  // report (read-only `taigent report`) opens; without a login there is nothing to choose.
  check(await page.isVisible('#taiga-report'), 'Taiga shows the Báo cáo panel');
  const reportSlugs = await page.locator('#taiga-report-project option').evaluateAll((options) => options.map((option) => option.value));
  if (login.loggedIn && reportSlugs.length > 0) {
    await page.selectOption('#taiga-report-project', reportSlugs[0]);
    await page.click('#taiga-report-run');
    await page.waitForSelector('#taiga-report-body :is(#taiga-report-result, .failure)', { timeout: 120_000 });
    check(await page.isVisible('#taiga-report-result'), `report of ${reportSlugs[0]} shown`);
    log('report:', (await page.textContent('#taiga-report-status'))?.trim());
    await page.locator('#taiga-report').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, '12-report.png') });
  } else {
    check(reportSlugs.length === 0 && (await page.isDisabled('#taiga-report-run')), 'Báo cáo has no project to choose');
    log('skipped report:', (await page.textContent('#taiga-report-status'))?.trim());
  }
  await smokeTickets({ app, page, work, shots, check, log, login });
  await smokeGit({ app, page, work, project, source, shots, check, goTo, log });
  await smokeWizard({ app, page, repo, work, shots, check, goTo, log });
  log('screenshots in', shots);
  log('temporary manifests in', manifests);
} catch (error) {
  await app.close();
  throw error;
}

// Quitting kills every process the app started: terminal shells, their children, the pseudo consoles, and the
// children outside the terminal. One of those is kept running at quit: the checklist's `claude --version`, which the
// wizard step's fake `claude` never answers (node on Windows, sleep elsewhere; the app's own timeout is 10 s).
const appPage = await app.firstWindow();
void appPage.evaluate(() => window.taigent.checkTools()).catch(() => undefined);
const hanging = (tree) => [...tree.values()].some((name) => /^(node(\.exe)?|sleep)$/i.test(name));
let appTree = descendants(app.process().pid);
for (let tries = 0; !hanging(appTree) && tries < 25; tries++) {
  await appPage.waitForTimeout(200);
  appTree = descendants(app.process().pid);
}
check(hanging(appTree), `before quitting, the checklist's hanging \`claude --version\` runs (${[...appTree.values()].join(', ')})`);
await app.close();
const survivors = await waitGone(appTree.keys());
check(survivors.length === 0, `after quitting, none of the app's ${appTree.size} child processes runs (left: ${survivors.map((pid) => `${pid} ${appTree.get(pid)}`).join(', ') || 'none'})`);

/**
 * Forms: an epic and a task written to backlog.yaml (new items are "Chưa duyệt"), the key lock of an item already on
 * Taiga, a save refused because an agent edited backlog.yaml while the form was open, and the removal warning.
 */
async function formScenario(page) {
  await page.click('#add-epic');
  await page.waitForSelector('#item-form[open]');
  await page.fill('#form-subject', 'Soạn backlog bằng form');
  const epicKey = await page.inputValue('#form-key');
  check(epicKey === 'SOAN-BACKLOG', `epic key suggested from the subject (${epicKey})`);
  await page.fill('#form-description', 'BA/PO thêm và sửa epic, story, task mà **không** phải sửa YAML.');
  check((await page.innerHTML('#form-preview-body')).includes('<strong>không</strong>'), 'the epic form previews its Markdown description');
  await page.fill('#form-tags', 'type:feature, area:review');
  await page.fill('#item-form [data-attribute="Mục tiêu quý"]', 'Q4');
  await page.screenshot({ path: join(shots, '6-epic-form.png') });
  await page.click('#form-save');
  // Selected, not just listed: the watcher's refresh can list the item before the save's own answer selects it.
  await page.waitForSelector(`#tree .node.selected[data-key="${epicKey}"]`);
  let text = await readFile(backlogFile, 'utf8');
  check(new RegExp(`- key: ${epicKey}\\r?\\n +subject: Soạn backlog bằng form`).test(text) && text.includes('Mục tiêu quý: Q4'), 'backlog.yaml has the new epic and its custom attribute');
  check(text.includes('# Legacy format: kept because the story is already on Taiga'), 'backlog.yaml keeps its comments');
  check(await page.isVisible('.detail-head .badge.unreviewed'), 'the new epic is "Chưa duyệt"');

  await page.click('#tree .node[data-key="REVIEW-APPROVE"]');
  await page.click('.detail-head [data-action="add-task"]');
  await page.waitForSelector('#item-form[open]');
  await page.fill('#form-subject', 'Kiểm tra form task');
  const taskKey = await page.inputValue('#form-key');
  check(taskKey === 'REVIEW-APPROVE-KIEM-TRA', `task key suggested under its story (${taskKey})`);
  await page.fill('#form-description', 'Done khi: task tạo bằng form nằm dưới story của nó trong `backlog.yaml`.');
  check((await page.innerHTML('#form-preview-body')).includes('<code>backlog.yaml</code>'), 'the task form previews its Markdown description');
  await page.click('#form-save');
  await page.waitForSelector(`#tree .node.selected[data-key="${taskKey}"]`);
  text = await readFile(backlogFile, 'utf8');
  const taskAt = text.indexOf(`- key: ${taskKey}`);
  check(text.indexOf('- key: REVIEW-APPROVE-STALE') < taskAt && taskAt < text.indexOf('- key: REVIEW-MARKDOWN'), 'backlog.yaml has the new task under REVIEW-APPROVE');
  check(await page.isVisible('.detail-head .badge.unreviewed'), 'the new task is "Chưa duyệt"');

  await page.click('#tree .node[data-key="REVIEW"]');
  await page.click('.detail-head [data-action="edit"]');
  await page.waitForSelector('#item-form[open]');
  check(await page.isDisabled('#form-key'), 'the key of an epic already on Taiga is locked');
  await page.click('#form-cancel');

  await page.click(`#tree .node[data-key="${taskKey}"]`);
  await page.click('.detail-head [data-action="edit"]');
  await page.waitForSelector('#item-form[open]');
  await page.fill('#form-subject', 'Kiểm tra form task (đã sửa)');
  const byAgent = (await readFile(backlogFile, 'utf8')).replace('subject: "Hạ tầng smoke test của desktop"', 'subject: "Hạ tầng smoke test của desktop (agent sửa)"');
  await writeFile(backlogFile, byAgent);
  await page.waitForSelector('#form-stale:not([hidden])', { timeout: 10_000 });
  log('ok - the open form notices that backlog.yaml changed');
  await page.click('#form-save');
  await page.waitForSelector('#conflict-dialog[open]');
  check((await page.textContent('#conflict-diff'))?.includes('(agent sửa)'), "the conflict dialog shows the agent's change");
  check((await readFile(backlogFile, 'utf8')) === byAgent, "the save is refused: backlog.yaml is still the agent's version");
  await page.screenshot({ path: join(shots, '7-conflict.png') });
  await page.click('#conflict-reapply');
  await page.waitForSelector('#item-form', { state: 'hidden' });
  text = await readFile(backlogFile, 'utf8');
  check(text.includes('(agent sửa)') && text.includes('Kiểm tra form task (đã sửa)'), "re-applied on the agent's version: backlog.yaml has both changes");

  await page.click('#tree .node[data-key="REVIEW-MARKDOWN"]');
  await page.click('.detail-head [data-action="remove"]');
  await page.waitForSelector('#remove-dialog[open]');
  const orphans = await page.textContent('#remove-orphans');
  check(orphans?.includes('mồ côi') && orphans.includes('REVIEW-MARKDOWN'), 'removing a story already on Taiga warns that it becomes an orphan');
  await page.screenshot({ path: join(shots, '8-remove-warning.png') });
  await page.click('#remove-cancel');
  check((await readFile(backlogFile, 'utf8')).includes('- key: REVIEW-MARKDOWN'), 'cancelling keeps the story');

  await page.click(`#tree .node[data-key="${taskKey}"]`);
  await page.click('.detail-head [data-action="remove"]');
  await page.waitForSelector('#remove-dialog[open]');
  check(!(await page.isVisible('#remove-orphans')), 'no orphan warning for an item not on Taiga');
  await page.click('#remove-confirm');
  await page.waitForSelector(`#tree .node[data-key="${taskKey}"]`, { state: 'detached' });
  check(!(await readFile(backlogFile, 'utf8')).includes(taskKey), 'the task is removed from backlog.yaml');
}

/** Sets (string) or removes (null) variables of the app's main process, which every CLI run inherits. */
async function setMainEnv(app, values) {
  return app.evaluate((_electron, vars) => {
    const before = {};
    for (const [name, value] of Object.entries(vars)) {
      before[name] = process.env[name] ?? null;
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    return before;
  }, values);
}

/**
 * Wiki: a page created with the form (file under pages/, entry in docs.yaml, the other entries kept), a bad slug
 * refused with its rule, an edit of the page; then "Đẩy wiki lên Taiga" against a fake Taiga: the confirm dialog lists
 * create, update and skip and is answered "Huỷ" (nothing written), a failed login and an edit on Taiga during the
 * upload (confirmed, on the fake only) show a Vietnamese message saying how to fix it.
 */
async function wikiScenario(page) {
  const dir = join(manifests, project);
  const docsFile = join(dir, 'docs.yaml');
  const docsBefore = await readFile(docsFile, 'utf8');
  await goTo(page, 'wiki');
  await page.waitForSelector('#wiki-pages .wiki-page[data-slug="quy-uoc-smoke"]');
  check((await page.locator('#wiki-pages .wiki-page').count()) === 2, 'Wiki lists the 2 pages of docs.yaml');

  await page.click('#wiki-add');
  await page.waitForSelector('#wiki-form[open]');
  await page.fill('#wiki-slug', 'Trang Smoke');
  await page.fill('#wiki-content', '# Trang smoke\n\nTạo bằng **form wiki** của desktop.\n');
  check((await page.textContent('#wiki-preview h1')) === 'Trang smoke', 'the form previews the Markdown');
  await page.click('#wiki-save');
  await page.waitForSelector('#wiki-form .field[data-field="slug"] .field-error:not([hidden])');
  check((await page.textContent('#wiki-form .field[data-field="slug"] .field-error'))?.includes('[wiki-slug]'), 'a slug that breaks the rule is refused with rule wiki-slug');
  check((await readFile(docsFile, 'utf8')) === docsBefore, 'nothing is written for a bad slug');
  await page.fill('#wiki-slug', 'trang-smoke');
  await page.screenshot({ path: join(shots, 'wiki-1-form.png') });
  await page.click('#wiki-save');
  await page.waitForSelector('#wiki-pages .wiki-page[data-slug="trang-smoke"]');
  const pageFile = join(dir, 'pages', 'trang-smoke.md');
  check((await readFile(pageFile, 'utf8')) === '# Trang smoke\n\nTạo bằng **form wiki** của desktop.\n', 'the page is written to pages/trang-smoke.md');
  const docs = await readFile(docsFile, 'utf8');
  check(docs.startsWith(docsBefore.trimEnd()) && /\n {2}- slug: trang-smoke\r?\n {4}file: pages\/trang-smoke\.md\r?\n$/.test(docs), 'docs.yaml has the new entry after the others, comments kept');

  await page.click('#wiki-pages .wiki-page[data-slug="trang-smoke"] [data-action="edit"]');
  await page.waitForSelector('#wiki-form[open]');
  check(await page.isDisabled('#wiki-slug'), 'the slug of an existing page is locked');
  await page.fill('#wiki-content', '# Trang smoke\n\nĐã sửa bằng form.\n');
  await page.click('#wiki-save');
  await page.waitForSelector('#wiki-form', { state: 'hidden' });
  check((await readFile(pageFile, 'utf8')) === '# Trang smoke\n\nĐã sửa bằng form.\n' && (await readFile(docsFile, 'utf8')) === docs, 'an edit rewrites the page file only');

  // "Đẩy wiki lên Taiga" against a fake Taiga holding the project, one page as written locally and one older page.
  const { startFakeTaiga } = await import(pathToFileURL(join(repo, 'test', 'support', 'fake-taiga.ts')).href);
  const fake = await startFakeTaiga();
  const before = await setMainEnv(app, { TAIGA_API_URL: fake.url, TAIGA_USERNAME: fake.user.username, TAIGA_PASSWORD: fake.user.password, TAIGA_TOKEN: null });
  try {
    const remote = fake.addProject({ slug: project });
    fake.addWikiPage({ project: remote.id, slug: 'huong-dan-review', content: await readFile(join(dir, 'pages', 'huong-dan-review.md'), 'utf8') });
    const older = fake.addWikiPage({ project: remote.id, slug: 'quy-uoc-smoke', content: '# Bản cũ\n' });
    const writes = () => fake.requests.filter((request) => request.method !== 'GET' && request.path !== '/auth').length;
    const upload = async () => {
      await app.evaluate(() => (globalThis.smokeDialogs = []));
      await page.click('#wiki-upload');
      await page.waitForSelector('#wiki-result h2', { timeout: 120_000 });
      return { title: (await page.textContent('#wiki-result h2'))?.trim(), text: await page.textContent('#wiki-result'), dialogs: await app.evaluate(() => globalThis.smokeDialogs) };
    };

    let run = await upload();
    const [dialog] = run.dialogs;
    check(run.dialogs.length === 1 && dialog.title === 'Đẩy wiki lên Taiga', 'upload --dry-run found changes and opened the confirm dialog');
    check(
      /Tạo mới: 1\n {2}• Trang wiki trang-smoke/.test(dialog.detail) && /Cập nhật: 1\n {2}• Trang wiki quy-uoc-smoke/.test(dialog.detail) && /Bỏ qua[^\n]*: 1\n {2}• Trang wiki huong-dan-review/.test(dialog.detail),
      'the dialog lists create, update and skip',
    );
    check(run.title === 'Đã huỷ đẩy wiki' && writes() === 0 && older.content === '# Bản cũ\n', 'answered "Huỷ": upload --yes never ran, nothing written to Taiga');
    await page.screenshot({ path: join(shots, 'wiki-2-upload-cancelled.png') });

    await setMainEnv(app, { TAIGA_PASSWORD: 'wrong-password' });
    run = await upload();
    check(run.dialogs.length === 0 && run.title === 'Chưa đẩy được wiki lên Taiga' && run.text?.includes('Cách sửa'), 'a refused login stops the dry run with a Vietnamese message and how to fix it');
    await setMainEnv(app, { TAIGA_PASSWORD: fake.user.password });

    // Confirmed on the fake only: someone edits the page on Taiga while it uploads.
    fake.onRequest({ method: 'PATCH', path: `/wiki/${older.id}`, run: () => fake.editWikiPage(older, { content: '# Sửa trên Taiga\n' }) });
    await app.evaluate(() => (globalThis.smokeAnswer = 0));
    run = await upload();
    await app.evaluate(() => (globalThis.smokeAnswer = 1));
    check(
      run.title === 'Chưa đẩy được wiki lên Taiga' && run.text?.includes('wiki:quy-uoc-smoke') && run.text.includes('Cách sửa') && older.content === '# Sửa trên Taiga\n',
      'a conflict during upload --yes shows a Vietnamese message with how to fix it; the page on Taiga is not overwritten',
    );
    await page.screenshot({ path: join(shots, 'wiki-3-upload-conflict.png') });
  } finally {
    await setMainEnv(app, before);
    await fake.close();
  }
  await goTo(page, 'backlog');
}

/**
 * Thay đổi › "Xem thay đổi trên Taiga" against a fake Taiga. The backlog is first applied to it with the CLI, so every
 * item has a baseline in state.json (else plan blocks them as `unknown`). Then story REVIEW-MARKDOWN is also linked to
 * an old taigent epic: the screen lists that stale link (and the old epic as an orphan) next to the changes. Last, the
 * story is edited on Taiga: plan exits 6 and the screen lists it as a blocked item. state.json is put back afterwards.
 */
async function staleLinkScenario(page) {
  const { startFakeTaiga } = await import(pathToFileURL(join(repo, 'test', 'support', 'fake-taiga.ts')).href);
  const fake = await startFakeTaiga();
  const credentials = { TAIGA_API_URL: fake.url, TAIGA_USERNAME: fake.user.username, TAIGA_PASSWORD: fake.user.password, TAIGA_TOKEN: null };
  const before = await setMainEnv(app, credentials);
  const stateFile = join(manifests, project, 'state.json');
  const recorded = await readFile(stateFile, 'utf8');
  try {
    const remote = fake.addProject({ slug: project });
    // The epic form step filled this attribute of project.yaml: plan needs the project to define it.
    fake.addCustomAttribute({ itemType: 'epic', project: remote.id, name: 'Mục tiêu quý' });
    // The fixture's state.json names items of another Taiga: start from none, then apply records every baseline.
    await writeFile(stateFile, JSON.stringify({ items: {} }));
    const applied = await taigentAsync(credentials, 'apply', '--project', project, '--yes', '--json');
    check(applied.status === 0, `taigent apply seeds the fake Taiga and the baselines (exit ${applied.status}: ${applied.stderr.trim()})`);
    const markdownId = JSON.parse(await readFile(stateFile, 'utf8')).items['REVIEW-MARKDOWN']?.id;
    const markdown = fake.state.userStories.find((candidate) => candidate.id === markdownId);
    check(markdown?.tags.includes('src:review-markdown'), 'apply created story REVIEW-MARKDOWN and state.json records it');
    const old = fake.addEpic({ project: remote.id, subject: 'Epic cũ', tags: ['src:old-review'] });
    fake.addEpicRelatedUserStory(old.id, markdown.id);
    const seeded = fake.requests.length;

    await goTo(page, 'changes');
    await page.click('#plan-btn');
    await page.waitForSelector('#changes-result h2', { timeout: 120_000 });
    const result = await page.textContent('#changes-result');
    const stale = await page.$('#plan-stale-links').then((node) => node?.textContent());
    check(
      stale?.includes(`Story #${markdown.ref} REVIEW-MARKDOWN → epic #${old.ref} OLD-REVIEW`) && stale.includes('không bao giờ gỡ'),
      `Thay đổi lists the stale link of REVIEW-MARKDOWN to the old epic, which apply never removes${stale ? '' : ` (screen: ${result})`}`,
    );
    check(result?.includes('OLD-REVIEW – Epic cũ'), 'the old epic is listed as an orphan');
    check(!(await page.isVisible('#plan-blocked')), `with the baselines of apply, nothing is blocked (screen: ${result})`);
    await page.screenshot({ path: join(shots, '9b-plan-stale-link.png') });

    // Edited on Taiga since apply: plan exits 6, and the plan still shows, with the blocked item.
    fake.editItem(markdown, { subject: 'Sửa trên Taiga giả' });
    await page.click('#plan-btn');
    await page.waitForSelector('#plan-blocked', { timeout: 120_000 });
    const title = await page.textContent('#changes-result h2');
    const blocked = await page.textContent('#plan-blocked');
    check(title?.includes('bị chặn'), `an exit-6 plan is shown as a plan with blocked items, not as a failure (${title})`);
    check(
      blocked?.includes('Sửa trên Taiga') && blocked.includes(`#${markdown.ref}`) && blocked.includes('REVIEW-MARKDOWN') && blocked.includes('subject'),
      `the blocked item names its kind, ref, key and fields (${blocked})`,
    );
    check(fake.requests.slice(seeded).every((request) => request.method === 'GET' || request.path === '/auth'), 'plan writes nothing to Taiga');
    await page.screenshot({ path: join(shots, '9c-plan-blocked.png') });
  } finally {
    await setMainEnv(app, before);
    await fake.close();
    await writeFile(stateFile, recorded);
  }
  await goTo(page, 'backlog');
}

/**
 * Badges of the preview (#61): an issue with a `ref` that state.json does not record yet shows "Adopt #ref"; once a
 * snapshot.json holds epic REVIEW with another subject (state.json has no baseline for it), the epic shows "Khác Taiga"
 * and the summary dates the snapshot. Without snapshot.json no such badge shows. Both files are put back afterwards.
 */
async function snapshotBadgeScenario(page) {
  const issue = 'BUG-STALE-AFTER-RENAME';
  const snapshotFile = join(manifests, project, 'snapshot.json');
  const backlog = await readFile(backlogFile, 'utf8');
  // A Windows checkout (core.autocrlf) has CRLF line endings.
  const adopting = backlog.replace(new RegExp(`( *)- key: ${issue}(\\r?\\n)`), `$1- key: ${issue}$2$1  ref: 99$2`);
  check(adopting !== backlog, `backlog.yaml declares issue ${issue}`);
  await writeFile(backlogFile, adopting);
  await page.waitForSelector(`#tree .node[data-key="${issue}"] .badge.adopt`, { timeout: 10_000 });
  check((await page.textContent(`#tree .node[data-key="${issue}"] .badge.adopt`)) === 'Adopt #99', `issue ${issue} with ref 99 is labelled Adopt #99`);
  check((await page.locator('#tree .badge.remote').count()) === 0, 'no remote badge without snapshot.json');

  const epic = { id: 1, ref: 1, version: 1, subject: 'Epic đã sửa trên Taiga', status: 'New', closed: false, tags: ['src:review'], key: 'REVIEW', description: '' };
  await writeFile(snapshotFile, JSON.stringify({ project: { id: 1, slug: project }, readAt: new Date().toISOString(), epics: [epic], stories: [], tasks: [], issues: [] }));
  await page.waitForSelector('#tree .node[data-key="REVIEW"] .badge.remote.unknown', { timeout: 10_000 });
  check((await page.textContent('#tree .node[data-key="REVIEW"] .badge.remote')) === 'Khác Taiga', 'epic REVIEW is labelled Khác Taiga from snapshot.json');
  check((await page.textContent('#summary'))?.includes('Snapshot Taiga'), 'the summary dates the snapshot');
  await page.screenshot({ path: join(shots, '9d-snapshot-badges.png') });

  await rm(snapshotFile);
  await writeFile(backlogFile, backlog);
  await page.waitForFunction(() => document.querySelectorAll('#tree .badge.remote, #tree .badge.adopt').length === 0, undefined, { timeout: 10_000 });
  log('ok - the badges go once snapshot.json and the ref are gone');
}

/** Runs the taigent CLI of this repository on the temporary manifests (offline commands only). */
function taigent(...args) {
  return spawnSync(process.execPath, [join(repo, 'bin', 'taigent.js'), ...args], { cwd: work, env: { ...process.env, TAIGENT_MANIFESTS_DIR: manifests }, encoding: 'utf8' });
}

/** Runs the taigent CLI on the temporary manifests with `env` on top, without blocking the in-process fake Taiga. */
function taigentAsync(env, ...args) {
  const merged = { ...process.env, TAIGENT_MANIFESTS_DIR: manifests };
  for (const [name, value] of Object.entries(env)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(repo, 'bin', 'taigent.js'), ...args], { cwd: work, env: merged });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/** The story `key` as backlog.yaml holds it now. */
async function manifestStory(key) {
  const backlog = parse(await readFile(backlogFile, 'utf8'));
  return backlog.epics.flatMap((epic) => epic.stories ?? []).find((candidate) => candidate.key === key);
}

/** The description `taigent preview --json` renders for story `key`: what apply writes to Taiga. */
function previewDescription(key) {
  const run = taigent('preview', '--project', project, '--json');
  if (run.status !== 0) throw new Error(`FAILED: taigent preview exited ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout).epics.flatMap((epic) => epic.stories).find((candidate) => candidate.key === key)?.description;
}

/**
 * Story form: a new story in the user story format with two scenarios (one with two Given), scenario add / move /
 * remove, an error shown on the broken scenario field, the live preview equal to what `taigent preview` renders, then
 * a legacy story edited without changing its format and converted to the user story format on request.
 */
async function storyFormScenario(page) {
  const cards = page.locator('#story-format .scenario');
  const names = () => cards.locator('.scenario-name').evaluateAll((inputs) => inputs.map((input) => input.value));

  await page.click('#tree .node[data-key="PUSH"]');
  await page.click('.detail-head [data-action="add-story"]');
  await page.waitForSelector('#item-form[open] #story-format[data-format="user-story"]');
  check((await page.inputValue('#form-parent')) === 'PUSH', 'the new story belongs to the epic it was added from');
  await page.fill('#form-subject', 'Soạn story bằng form');
  const storyKey = await page.inputValue('#form-key');
  check(storyKey === 'PUSH-SOAN-STORY', `story key suggested under its epic (${storyKey})`);
  await page.fill('#story-as-a', 'BA soạn backlog');
  await page.fill('#story-i-want-to', 'viết story theo user story format bằng form');
  await page.fill('#story-so-that', 'không phải sửa YAML bằng tay');
  await cards.nth(0).locator('.scenario-name').fill('Story có nhiều Given');
  await cards.nth(0).locator('.scenario-given').nth(0).fill('Tôi đang mở form story');
  await cards.nth(0).locator('[data-action="add-given"]').click();
  await cards.nth(0).locator('.scenario-given').nth(1).fill('Epic cha đã có trong backlog');
  await cards.nth(0).locator('.scenario-when').fill('Tôi lưu story');
  await cards.nth(0).locator('.scenario-then').fill('backlog.yaml có story với use_case và scenarios');
  await page.click('#story-add-scenario');
  await cards.nth(1).locator('.scenario-name').fill('Thiếu When');
  await cards.nth(1).locator('.scenario-given').fill('Một scenario chưa có When');
  await cards.nth(1).locator('.scenario-then').fill('Form báo lỗi ngay tại ô When');
  await page.click('#story-add-scenario');
  await cards.nth(2).locator('.scenario-name').fill('Tạm');
  await cards.nth(2).locator('[data-action="up"]').click();
  check(JSON.stringify(await names()) === JSON.stringify(['Story có nhiều Given', 'Tạm', 'Thiếu When']), 'a scenario moves up');
  await cards.nth(1).locator('[data-action="remove-scenario"]').click();
  check(JSON.stringify(await names()) === JSON.stringify(['Story có nhiều Given', 'Thiếu When']), 'a scenario is removed');

  const before = await readFile(backlogFile, 'utf8');
  await page.click('#form-save');
  const whenError = cards.nth(1).locator('[data-part="when"] > .field-error');
  await whenError.waitFor({ state: 'visible' });
  check((await whenError.textContent())?.includes('[required]'), 'the empty When is reported on its own field, with the validate rule');
  check((await readFile(backlogFile, 'utf8')) === before, 'nothing is written while the story is invalid');

  await cards.nth(1).locator('.scenario-when').fill('Tôi điền When rồi lưu lại');
  await page.fill('#form-description', 'Form story dùng cùng luật với `taigent validate`.');
  await page.fill('#form-spec', 'docs/desktop.md');
  await page.fill('#form-tags', 'type:feature, area:push');
  const source = await page.textContent('#form-preview-source');
  const html = await page.innerHTML('#form-preview-body');
  check(source.includes('**and Given:** Epic cha đã có trong backlog') && html.includes('Story có nhiều Given'), 'the live preview shows the scenarios');
  await page.screenshot({ path: join(shots, '10-story-form.png') });
  await page.click('#form-save');
  await page.waitForSelector(`#tree .node.selected[data-key="${storyKey}"]`);
  const created = await manifestStory(storyKey);
  check(
    Object.keys(created).join() === 'key,subject,use_case,scenarios,description,spec,tags' &&
      created.scenarios.length === 2 &&
      created.scenarios[0].given.length === 2 &&
      Object.keys(created.scenarios[0]).join() === 'scenario,given,when,then',
    'backlog.yaml has the story in the user story format: use_case and two scenarios, one with two Given',
  );
  const validate = taigent('validate', '--project', project);
  check(validate.status === 0, `taigent validate exits 0 (${validate.status}) ${validate.stderr.trim()}`);
  check(previewDescription(storyKey) === source, 'the form preview is exactly the description taigent preview renders');
  check(
    (await page.innerHTML('#detail-content .markdown')) === html,
    `the form preview renders like the review screen (same renderer and sanitizer; detail shows ${(await page.textContent('.breadcrumb'))?.trim()})`,
  );
  check(await page.isVisible('.detail-head .badge.unreviewed'), 'the new story is "Chưa duyệt"');

  // A legacy story is edited in the legacy mode: its format stays.
  await page.click('#tree .node[data-key="REVIEW-MARKDOWN"]');
  await page.click('.detail-head [data-action="edit"]');
  await page.waitForSelector('#item-form[open] #story-format[data-format="legacy"]');
  check(!(await page.isVisible('#story-as-a')) && (await page.locator('#story-format .criterion').count()) === 2, 'a legacy story opens in the legacy mode with its acceptance criteria');
  await page.fill('#form-description', 'Là BA, tôi muốn thấy mô tả story đúng như Taiga sẽ hiển thị (sửa bằng form).');
  await page.click('#form-save');
  await page.waitForSelector('#item-form', { state: 'hidden' });
  let legacy = await manifestStory('REVIEW-MARKDOWN');
  check(legacy.acceptance_criteria?.length === 2 && !('use_case' in legacy) && legacy.description.endsWith('(sửa bằng form).'), 'editing a legacy story keeps its format');

  // "Chuyển sang user story format" runs only when chosen.
  await page.click('.detail-head [data-action="edit"]');
  await page.waitForSelector('#item-form[open] #story-format[data-format="legacy"]');
  await page.click('#story-convert');
  await page.waitForSelector('#story-format[data-format="user-story"] #story-converted');
  check(JSON.stringify(await names()) === JSON.stringify(legacy.acceptance_criteria), 'each acceptance criterion becomes a scenario to complete');
  await page.fill('#story-as-a', 'BA đang duyệt backlog');
  await page.fill('#story-i-want-to', 'thấy mô tả story đúng như trên Taiga');
  await page.fill('#story-so-that', 'duyệt đúng thứ sẽ được ghi');
  for (let i = 0; i < 2; i++) {
    await cards.nth(i).locator('.scenario-given').fill('Tôi đang xem chi tiết story');
    await cards.nth(i).locator('.scenario-when').fill('Mô tả có Markdown');
    await cards.nth(i).locator('.scenario-then').fill('Mô tả hiển thị như trên Taiga');
  }
  const converted = await page.textContent('#form-preview-source');
  await page.screenshot({ path: join(shots, '11-story-converted.png') });
  await page.click('#form-save');
  await page.waitForSelector('#item-form', { state: 'hidden' });
  legacy = await manifestStory('REVIEW-MARKDOWN');
  check(!('acceptance_criteria' in legacy) && legacy.use_case && legacy.scenarios.length === 2, 'the converted story has use_case + scenarios instead of acceptance_criteria');
  check(taigent('validate', '--project', project).status === 0, 'taigent validate exits 0 after the conversion');
  check(previewDescription('REVIEW-MARKDOWN') === converted, 'the converted story preview is what taigent preview renders (plan reports it as a description update)');
}

/**
 * Issue form: "+ Issue" in the Issues group opens a form whose description holds the §6.4 template, with a Markdown
 * preview; type / severity / priority are dropdowns of the project's Taiga values when `taigent projects --project
 * <slug> --json` lists them (logged in, project on Taiga), free text otherwise. The saved issue is valid, "Chưa duyệt",
 * and edits back through the "Sửa" button.
 */
async function issueFormScenario(page) {
  await page.click('#add-issue');
  await page.waitForSelector('#item-form[open] #form-type');
  const template = await page.inputValue('#form-description');
  check(['## Steps to reproduce', '## Expected', '## Actual'].every((label) => template.includes(label)), 'a new issue starts from the Steps to reproduce / Expected / Actual template');
  await page.waitForFunction(() => !document.querySelector('#form-values-hint')?.textContent?.startsWith('Đang đọc'), null, { timeout: 120_000 });
  const detail = await page.evaluate((slug) => window.taigent.readTaigaProject(slug), project);
  const taiga = detail.ok ? detail.value.taiga : undefined;
  const chosen = {};
  if (taiga) {
    for (const [name, list] of [['type', taiga.issueTypes], ['severity', taiga.severities], ['priority', taiga.priorities]]) {
      const options = await page.$$eval(`select#form-${name} option`, (nodes) => nodes.map((node) => node.value).filter(Boolean));
      check(JSON.stringify(options) === JSON.stringify(list), `the ${name} dropdown lists the project's values on Taiga (${list.join(', ')})`);
      chosen[name] = list[0];
      await page.selectOption(`#form-${name}`, chosen[name]);
    }
  } else {
    log(`issue values are free text: ${await page.textContent('#form-values-hint')}`);
    check((await page.$('input#form-type')) !== null, 'without the Taiga values, type / severity / priority are free text');
    Object.assign(chosen, { type: 'Bug', severity: 'Normal', priority: 'High' });
    for (const [name, value] of Object.entries(chosen)) await page.fill(`#form-${name}`, value);
  }
  await page.fill('#form-subject', 'Form issue mất mẫu mô tả khi lưu');
  const issueKey = await page.inputValue('#form-key');
  const { issueKeyPrefix } = await import(pathToFileURL(join(repo, 'src', 'manifest', 'conventions.ts')).href);
  check(issueKey.startsWith(`${issueKeyPrefix(chosen.type)}-`), `the issue key is suggested with the prefix of its type ${chosen.type} (${issueKey})`);
  if (!taiga) {
    await page.fill('#form-type', 'Question');
    check((await page.inputValue('#form-key')).startsWith('ASK-'), 'changing the issue type to Question suggests an ASK- key');
    await page.fill('#form-type', chosen.type);
    check((await page.inputValue('#form-key')) === issueKey, 'changing the type back suggests the first key again');
  }
  const description = '## Steps to reproduce\n\n1. Mở form issue\n2. Lưu\n\n## Expected\n\nMô tả giữ nguyên.\n\n## Actual\n\nMô tả bị mất.';
  await page.fill('#form-description', description);
  await page.fill('#form-tags', 'area:review');
  await page.waitForSelector('#form-preview-body h2');
  check((await page.textContent('#form-preview-body h2')) === 'Steps to reproduce', 'the issue form previews its Markdown description');
  await page.screenshot({ path: join(shots, '12-issue-form.png') });
  await page.click('#form-save');
  await page.waitForSelector('#item-form', { state: 'hidden' });
  let saved = parse(await readFile(backlogFile, 'utf8')).issues.find((candidate) => candidate.key === issueKey);
  check(
    saved?.subject === 'Form issue mất mẫu mô tả khi lưu' && saved.description === description && saved.type === chosen.type && saved.severity === chosen.severity && saved.priority === chosen.priority && saved.tags?.[0] === 'area:review',
    'backlog.yaml has the new issue with subject, description, type, severity, priority and tags',
  );
  check(taigent('validate', '--project', project).status === 0, 'taigent validate exits 0 after the issue form');
  check(!(await readFile(reviewFile, 'utf8')).includes(issueKey), 'the new issue has no verdict in review.yaml (Chưa duyệt)');
  await page.click(`#tree .node[data-key="${issueKey}"]`);
  check((await page.textContent('.detail-head'))?.includes('Chưa duyệt'), 'the new issue shows as Chưa duyệt');

  await page.click('.detail-head [data-action="edit"]');
  await page.waitForSelector('#item-form[open] #form-type');
  check((await page.inputValue('#form-type')) === chosen.type && (await page.inputValue('#form-description')) === description, 'editing the issue opens its saved values');
  await page.fill('#form-subject', 'Form issue mất mẫu mô tả khi lưu (đã sửa)');
  await page.click('#form-save');
  await page.waitForSelector('#item-form', { state: 'hidden' });
  saved = parse(await readFile(backlogFile, 'utf8')).issues.find((candidate) => candidate.key === issueKey);
  check(saved?.subject.endsWith('(đã sửa)') && saved.type === chosen.type, 'the edited issue is saved in place');
}

/**
 * Logged in: the issue form of a project on Taiga offers the project's values as dropdowns. The fixture is not on
 * Taiga, so this opens an empty backlog for the first Taiga project the user is a member of (read-only: the form is
 * cancelled, nothing is saved), then removes it and reopens the fixture.
 */
async function issueValuesOnTaiga(page) {
  const listed = await page.evaluate(() => window.taigent.listTaigaProjects());
  const onTaiga = listed.ok ? listed.value.rows.find((row) => row.taiga && row.slug !== project) : undefined;
  if (!onTaiga) {
    log('skipped issue dropdowns: no Taiga project listed');
    return;
  }
  const dir = join(manifests, onTaiga.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'backlog.yaml'), 'epics: []\n');
  await page.click('#open-repo');
  await page.waitForFunction((slug) => [...document.querySelectorAll('#project-select option')].some((option) => option.value === slug), onTaiga.slug);
  await page.selectOption('#project-select', onTaiga.slug);
  await page.click('#add-issue');
  await page.waitForSelector('#item-form[open] select#form-type', { timeout: 120_000 });
  const detail = await page.evaluate((slug) => window.taigent.readTaigaProject(slug), onTaiga.slug);
  const taiga = detail.ok ? detail.value.taiga : undefined;
  check(taiga !== undefined, `taigent projects --project ${onTaiga.slug} --json lists the issue values`);
  for (const [name, list] of [['type', taiga.issueTypes], ['severity', taiga.severities], ['priority', taiga.priorities]]) {
    const options = await page.$$eval(`select#form-${name} option`, (nodes) => nodes.map((node) => node.value).filter(Boolean));
    check(options.length > 0 && JSON.stringify(options) === JSON.stringify(list), `logged in, the ${name} dropdown of ${onTaiga.slug} lists its Taiga values (${list.join(', ')})`);
  }
  await page.screenshot({ path: join(shots, '12b-issue-dropdowns.png') });
  await page.click('#form-cancel');
  await rm(dir, { recursive: true, force: true });
  await page.click('#open-repo');
  await page.waitForFunction((slug) => document.querySelector('#project-select')?.value === slug, project);
}

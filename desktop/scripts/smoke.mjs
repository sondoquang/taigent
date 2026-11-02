// Smoke test of Taigent Desktop, driven with Playwright's Electron support. It never touches the user's manifests:
// it copies the committed fixture `scripts/fixture/smoke-taigent-desktop` (or `taiga/<slug>` of the repository with
// --project) to a temporary folder and points the app there with TAIGENT_MANIFESTS_DIR, and it uses a temporary
// user-data folder. It never pushes to Taiga: the native confirm dialog is stubbed to "Huỷ", and "Xem thay đổi trên
// Taiga" (read-only) runs only when the app reports a login.
//
//   node scripts/smoke.mjs [--project <slug> --story <key>] [--exe <packaged app exe>] [--out <screenshot dir>]

import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

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
  args: [...(values.exe ? [] : [desktop]), `--user-data-dir=${join(work, 'user-data')}`],
  env: { ...process.env, TAIGENT_MANIFESTS_DIR: manifests },
  cwd: repo,
});
const log = (...parts) => console.log('[smoke]', ...parts);
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log('ok -', message);
};
const SECTIONS = ['backlog', 'wiki', 'taiga', 'changes', 'git', 'settings'];
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
  // The folder dialog and the push confirmation are native: answer them from the main process.
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  }, repo);
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
  await page.waitForLoadState('domcontentloaded');
  const sections = await page.locator('#nav [data-section]').evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim()));
  check(sections.join('|') === 'Backlog|Wiki|Taiga|Thay đổi|Git|Settings', `navigation shows ${sections.join(', ')}`);
  check((await page.isVisible('#screen-backlog')) && !(await page.isVisible('#screen-changes')), 'the app opens on Backlog');

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

  // Switching sections keeps the open project and the selected item; sections without content yet have no controls.
  for (const section of ['wiki', 'taiga', 'git', 'settings']) {
    await goTo(page, section);
    const controls = await page.locator(`#screen-${section} :is(button, input, select, textarea, a)`).count();
    check(controls === 0, `section ${section} shows an empty state without controls`);
    await page.keyboard.press('j');
    await page.screenshot({ path: join(shots, `nav-${section}.png`) });
  }
  await goTo(page, 'backlog');
  check((await page.inputValue('#project-select')) === project, 'project still open after switching sections');
  check((await page.getAttribute('#tree .node.selected', 'data-key')) === story, `${story} still selected after switching sections (j ignored outside Backlog)`);
  check((await page.textContent('.breadcrumb'))?.includes(story), `detail still shows ${story}`);

  // Approve, then change the story's description as an agent would: the approval turns stale.
  await page.click('.verdict-bar [data-verdict="approved"]');
  await page.waitForSelector('.verdict-bar .verdict.approve.on');
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

  await page.waitForFunction(() => document.querySelector('#statusbar')?.textContent?.includes('Taiga'), null, { timeout: 30_000 }).catch(() => undefined);
  const login = await page.evaluate(() => window.taigent.whoami());
  log('login', JSON.stringify({ loggedIn: login.loggedIn, username: login.username, apiUrl: login.apiUrl, message: login.message }));
  if (login.loggedIn) {
    await goTo(page, 'changes');
    await page.click('#plan-btn');
    await page.waitForSelector('#changes-result h2', { timeout: 120_000 });
    log('plan result:', (await page.textContent('#changes-result h2'))?.trim());
    await page.screenshot({ path: join(shots, '6-plan.png') });
    await goTo(page, 'backlog');
  } else {
    log('skipped plan: not logged in');
  }
  log('screenshots in', shots);
  log('temporary manifests in', manifests);
} finally {
  await app.close();
}

// Smoke test of Taigent Desktop, driven with Playwright's Electron support. It never touches the user's manifests:
// it copies `taiga/<slug>` of the repository to a temporary folder and points the app there with
// TAIGENT_MANIFESTS_DIR, and it uses a temporary user-data folder. It never pushes to Taiga: the native confirm
// dialog is stubbed to "Huỷ", and "Xem thay đổi trên Taiga" (read-only) runs only when the app reports a login.
//
//   node scripts/smoke.mjs [--project <slug>] [--story <key>] [--exe <packaged app exe>] [--out <screenshot dir>]

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
    project: { type: 'string', default: 'internal-taigent' },
    story: { type: 'string', default: 'SETUP-ENV' },
    exe: { type: 'string' },
    out: { type: 'string', default: join(repo, 'tmp', 'desktop-smoke') },
  },
});
const { project, story } = values;
const shots = resolve(values.out);
const work = await mkdtemp(join(tmpdir(), 'taigent-desktop-smoke-'));
const manifests = join(work, 'taiga');
await cp(join(repo, 'taiga', project), join(manifests, project), { recursive: true });
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
  await page.click('#apply-btn');
  await page.waitForSelector('#result-dialog[open]');
  const blocked = await page.textContent('#result-content');
  check(blocked?.includes('Chưa thể đẩy lên Taiga') && blocked.includes(story), 'push blocked by the open comment');
  await page.screenshot({ path: join(shots, '4-push-blocked.png') });
  await page.click('#result-close');

  // Approve, then change the story's description as an agent would: the approval turns stale.
  await page.click('.verdict-bar [data-verdict="approved"]');
  await page.waitForSelector('.verdict-bar .verdict.approve.on');
  check((await readFile(reviewFile, 'utf8')).includes('verdict: approved'), 'review.yaml has verdict approved');
  const backlog = await readFile(backlogFile, 'utf8');
  const marker = `- key: ${story}\n`;
  const at = backlog.indexOf(marker);
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
    await page.click('#plan-btn');
    await page.waitForSelector('#result-dialog[open]', { timeout: 120_000 });
    log('plan dialog:', (await page.textContent('#result-content h2'))?.trim());
    await page.screenshot({ path: join(shots, '6-plan.png') });
    await page.click('#result-close');
  } else {
    log('skipped plan: not logged in');
  }
  log('screenshots in', shots);
  log('temporary manifests in', manifests);
} finally {
  await app.close();
}

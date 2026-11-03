// Smoke step of the setup wizard (spec #35, ticket #40), run by smoke.mjs after the Git step. Everything happens in a
// temporary folder: the wizard creates a new repository there (git init + taiga/ + `taigent init` of the app's own
// taigent), runs `npm install` in a terminal tab (a fake `npm` first on PATH), and its checklist must show each tool's
// real state: git found with its version, `codex` an npm cmd-shim whose version is read without a shell, `claude` a
// fake that never answers `--version` (the timeout), `omp` missing with its install command. Then: a repository whose
// Taigent skills are older than the app gets the suggestion to re-run init; a failed clone explains in Vietnamese and
// leaves no folder; the credentials in a clone URL appear in no error; a clone of a temporary bare remote opens and is
// offered the setup; a repository already set up opens without asking for setup again.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const windows = process.platform === 'win32';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/**
 * Fake tools in `bin`, the first folder of the app's PATH: `codex` prints a version, `claude` hangs on `--version`,
 * `npm` prints its arguments and working directory. On Windows `codex` and `claude` are npm cmd-shims (the `.cmd` npm
 * writes for a global package), run by node.
 */
async function fakeTools(bin) {
  const codex = "if (process.argv.includes('--version')) console.log('codex-cli 9.9.9-smoke');\n";
  const claude = "if (process.argv.includes('--version')) setInterval(() => {}, 1000);\nelse console.log(`fake-claude in ${process.cwd()}`);\n";
  if (windows) {
    for (const [name, script] of [['codex', codex], ['claude', claude]]) {
      await mkdir(join(bin, 'node_modules', `fake-${name}`), { recursive: true });
      await writeFile(join(bin, 'node_modules', `fake-${name}`, 'cli.js'), script);
      // The shim cmd-shim writes for `npm install -g`, verbatim but for the script path.
      await writeFile(
        join(bin, `${name}.cmd`),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          '',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          '',
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-${name}\\cli.js" %*`,
          '',
        ].join('\r\n'),
      );
    }
    await writeFile(join(bin, 'npm.cmd'), '@echo off\r\necho fake-npm %* in %CD%\r\n');
  } else {
    const scripts = {
      codex: '#!/bin/sh\necho "codex-cli 9.9.9-smoke"\n',
      claude: '#!/bin/sh\n[ "$1" = --version ] && exec sleep 600\necho "fake-claude in $PWD"\n',
      npm: '#!/bin/sh\necho "fake-npm $* in $PWD"\n',
    };
    for (const [name, script] of Object.entries(scripts)) {
      await writeFile(join(bin, name), script);
      await chmod(join(bin, name), 0o755);
    }
  }
}

/** What `taigent init --dry-run --json` of this repository's taigent reports for `root`. */
function initDryRun(repo, root) {
  const run = spawnSync(process.execPath, [join(repo, 'bin', 'taigent.js'), 'init', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
  return { code: run.status, files: JSON.parse(run.stdout).files };
}

export async function smokeWizard({ app, page, repo, work, shots, check, goTo, log }) {
  const base = join(work, 'wizard');
  await mkdir(base, { recursive: true });
  // The first folder of the app's PATH, whichever fakes the earlier steps put there: these fakes win from now on.
  await fakeTools(await app.evaluate(() => (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')[0]));
  await app.evaluate(({ dialog }, parent) => {
    delete process.env.TAIGENT_MANIFESTS_DIR;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [parent] });
  }, base);
  const pickNext = (path) => app.evaluate(({ dialog }, picked) => (dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })), path);
  const setupState = () => page.getAttribute('#setup-status', 'data-state');
  const waitSetupState = (state) =>
    page.waitForFunction((wanted) => document.querySelector('#setup-status')?.getAttribute('data-state') === wanted, state, { timeout: 60_000 });
  const bannerState = async () => ((await page.isVisible('#setup-banner')) ? page.getAttribute('#setup-banner', 'data-state') : undefined);

  // 1. A new repository: folder + git init + taiga/, then the app's taigent init.
  await goTo(page, 'setup');
  await page.click('#setup-parent');
  await page.waitForFunction((parent) => document.querySelector('#setup-parent-path')?.textContent === parent, base);
  const created = join(base, 'du-an-moi');
  await page.fill('#setup-new-name', 'du-an-moi');
  await page.click('#setup-new-create');
  await page.waitForSelector('#setup-init-result tr[data-status]', { state: 'attached', timeout: 120_000 });
  check(existsSync(join(created, '.git')) && existsSync(join(created, 'taiga')), 'wizard: the new repository has .git and taiga/');
  check((await page.textContent('#repo-path')) === created, `wizard: the new repository is the opened one (${created})`);
  const after = initDryRun(repo, created);
  check(after.code === 0 && after.files.every((file) => file.status === 'unchanged'), `wizard: taigent init installed everything (${after.files.length} files, dry run finds nothing to do)`);
  for (const path of ['.agents/skills/taiga-setup/SKILL.md', '.claude/skills/taiga-setup/SKILL.md', 'tools/taiga/allowlist.txt', '.mcp.json', '.codex/config.toml', 'package.json']) {
    check(existsSync(join(created, path)), `wizard: init wrote ${path}`);
  }
  check(JSON.parse(await readFile(join(created, '.mcp.json'), 'utf8')).mcpServers?.taiga !== undefined, 'wizard: .mcp.json has the taiga server');
  const rows = await page.locator('#setup-init-result tr[data-status]').evaluateAll((trs) => trs.map((tr) => `${tr.dataset.path}=${tr.dataset.status}`));
  check(
    rows.length === after.files.length && rows.every((row) => row.endsWith('=created')),
    `wizard: lists the ${rows.length} files init created`,
  );
  await waitSetupState('current');
  check((await bannerState()) === undefined, 'wizard: no setup suggestion for the set-up repository');
  await page.screenshot({ path: join(shots, 'wizard-1-created.png') });

  // 2. npm install runs in a terminal tab at the repository.
  const tabsBefore = await page.locator('.terminal-tab').count();
  await page.click('#setup-npm');
  await page.waitForFunction((count) => document.querySelectorAll('.terminal-tab').length === count + 1, tabsBefore);
  const npmTab = page.locator('.terminal-tab.active');
  check((await npmTab.getAttribute('data-kind')) === 'skill' && (await npmTab.textContent())?.includes('npm install'), 'wizard: npm install opens a terminal tab');
  await page.waitForFunction(() => /mã 0/.test(document.querySelector('#setup-npm-result')?.textContent ?? ''), null, { timeout: 60_000 });
  const npmText = await page
    .locator(`.terminal-view[data-id="${await npmTab.getAttribute('data-id')}"] .xterm-rows`)
    .evaluate((rows) => (rows.textContent ?? '').replaceAll('\u00a0', ' '));
  check(npmText.toLowerCase().includes(`fake-npm install in ${created}`.toLowerCase()), 'wizard: npm install ran in the new repository and the wizard shows it ended with code 0');
  await page.click('#terminal-hide');

  // 3. The checklist: each tool's state from `--version` run without a shell, with a timeout.
  await page.click('#setup-recheck');
  await page.waitForFunction(() => document.querySelectorAll('#setup-checklist li[data-item][data-state="checking"]').length === 0 && document.querySelector('#setup-checklist li[data-item="git"]'), null, { timeout: 60_000 });
  const item = async (name) => ({
    state: await page.getAttribute(`#setup-checklist li[data-item="${name}"]`, 'data-state'),
    text: (await page.textContent(`#setup-checklist li[data-item="${name}"]`)) ?? '',
  });
  const gitVersion = git(base, '--version').match(/\d+\.\d+\.\d+/)?.[0];
  const gitItem = await item('git');
  check(gitItem.state === 'ok' && gitItem.text.includes(gitVersion), `checklist: git ${gitVersion}`);
  const codexItem = await item('codex');
  check(codexItem.state === 'ok' && codexItem.text.includes('9.9.9-smoke'), 'checklist: codex version read from its npm shim');
  const claudeItem = await item('claude');
  check(claudeItem.state === 'timeout' && /không trả lời/.test(claudeItem.text), 'checklist: claude never answers --version, shown as timed out');
  const ompItem = await item('omp');
  check(ompItem.state === 'missing' && /Chưa cài/.test(ompItem.text) && ompItem.text.includes('omp.sh') && (await page.isVisible('#setup-checklist [data-install="omp"]')), 'checklist: omp missing, with its install command and a button to run it');
  const login = await page.evaluate(() => window.taigent.whoami());
  const loginItem = await item('login');
  check(loginItem.state === (login.loggedIn ? 'ok' : 'missing'), `checklist: Taiga login ${login.loggedIn ? `as ${login.username}` : 'missing, with the login button'}`);
  if (!login.loggedIn) check(await page.isVisible('#setup-login'), 'checklist: shows the login button');
  check((await item('mcp')).text.includes('taiga'), 'checklist: reminds to approve the taiga MCP server');
  await page.screenshot({ path: join(shots, 'wizard-2-checklist.png') });

  // 4. Skills older than the app's: the app suggests re-running init, which brings them up to date.
  await appendFile(join(created, '.agents', 'skills', 'taiga-setup', 'SKILL.md'), '\nBản cũ.\n');
  await pickNext(created);
  await goTo(page, 'backlog');
  await page.click('#open-repo');
  await page.waitForSelector('#setup-banner[data-state="outdated"]', { timeout: 60_000 });
  check((await page.textContent('#setup-banner'))?.includes('init'), 'outdated skills: the app suggests re-running init');
  await page.screenshot({ path: join(shots, 'wizard-3-outdated.png') });
  await page.click('#setup-banner-action');
  await page.waitForSelector('#screen-setup', { state: 'visible' });
  check((await setupState()) === 'outdated', 'outdated skills: the wizard shows the repository as outdated');
  await page.click('#setup-init');
  await page.waitForSelector('#setup-init-result tr[data-status="updated"]', { state: 'attached', timeout: 60_000 });
  await waitSetupState('current');
  check(initDryRun(repo, created).code === 0, 'outdated skills: init again brought the repository up to date');

  // 5. A failed clone explains in Vietnamese and leaves no folder.
  const missing = join(base, 'khong-co.git');
  await page.fill('#setup-clone-url', missing);
  check((await page.inputValue('#setup-clone-name')) === 'khong-co', 'clone: the folder name comes from the URL');
  await page.click('#setup-clone-go');
  await page.waitForSelector('#setup-repo-result .failure', { timeout: 120_000 });
  const failure = (await page.textContent('#setup-repo-result')) ?? '';
  check(/Không tìm thấy repo/.test(failure), `clone: a wrong URL is explained in Vietnamese (${failure.trim().split('\n')[0]?.slice(0, 80)})`);
  check(!existsSync(join(base, 'khong-co')), 'clone: no partial folder left behind');
  check((await page.textContent('#repo-path')) === created, 'clone: the opened repository did not change');
  await page.screenshot({ path: join(shots, 'wizard-4-clone-failed.png') });

  // 5b. Credentials in a clone URL never show: neither when the URL is refused nor in git's own error.
  for (const url of [
    'ftp://smoke-user:smoke-token@example.invalid/team.git',
    'smoke-user:smoke-token@example.invalid:team.git',
    'https://smoke-user:smoke-token@127.0.0.1:9/team.git',
  ]) {
    const result = await page.evaluate((input) => window.taigent.cloneRepo(input), { url, parent: base, name: 'khong-lo-token' });
    const shown = JSON.stringify(result);
    check(!result.ok && !shown.includes('smoke-token') && !shown.includes('smoke-user:'), `clone: the credentials in ${url.split('@')[1]} stay hidden (${result.message})`);
  }
  check(!existsSync(join(base, 'khong-lo-token')), 'clone: no folder left by the refused URLs');

  // 6. A clone of a team repository without Taigent opens and is offered the setup.
  const remote = join(base, 'team.git');
  const seed = join(work, 'wizard-seed');
  await mkdir(seed, { recursive: true });
  git(base, 'init', '--quiet', '--bare', remote);
  for (const args of [['init', '--quiet'], ['config', 'user.name', 'Taigent Smoke'], ['config', 'user.email', 'smoke@example.invalid']]) git(seed, ...args);
  await writeFile(join(seed, 'README.md'), '# Team\n');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'chore: seed');
  git(seed, 'push', '--quiet', remote, 'HEAD');
  await page.fill('#setup-clone-url', remote);
  await page.fill('#setup-clone-name', 'team-clone');
  await page.click('#setup-clone-go');
  const cloned = join(base, 'team-clone');
  await page.waitForFunction((path) => document.querySelector('#repo-path')?.textContent === path, cloned, { timeout: 120_000 });
  check(existsSync(join(cloned, 'README.md')), 'clone: the repository is cloned and opened');
  await waitSetupState('none');
  log('ok - clone: a repository without Taigent is offered the setup');
  await page.click('#setup-init');
  await page.waitForSelector('#setup-init-result tr[data-status="created"]', { state: 'attached', timeout: 60_000 });
  await waitSetupState('current');

  // 7. Opening a repository already set up asks for nothing.
  await pickNext(created);
  await goTo(page, 'backlog');
  await page.click('#open-repo');
  await page.waitForFunction((path) => document.querySelector('#repo-path')?.textContent === path, created);
  await page.waitForFunction(() => !['checking', undefined, null].includes(document.querySelector('#setup-status')?.getAttribute('data-state')), null, { timeout: 60_000 });
  check((await setupState()) === 'current' && (await bannerState()) === undefined, 'a repository already set up opens without asking for setup again');
  await page.screenshot({ path: join(shots, 'wizard-5-set-up.png') });
}

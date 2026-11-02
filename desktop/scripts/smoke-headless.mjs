// Headless steps of the desktop smoke (scripts/smoke.mjs): the Settings choice of the agent (saved in the app
// settings), then each button of the Backlog section run through the bundled run-skill in `--dry-run` mode (the app is
// launched with TAIGENT_RUN_SKILL_DRY_RUN=1): its `skill` tab shows exactly the command run-skill builds for that agent,
// skill and request in this repository. Then, without --dry-run and with a fake `codex` first on PATH, the agent runs
// with TAIGENT_READ_ONLY=1, Huỷ kills the run's process tree and the tab says it was cancelled, and a failing run shows
// its exit code and last error line.

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { descendants, waitGone } from './smoke-terminal.mjs';

const windows = process.platform === 'win32';

/**
 * `path` with a folder holding a fake `codex` first: `codex exec` prints where it runs and its TAIGENT_READ_ONLY, then
 * waits (or fails with exit 3 when SMOKE_CODEX=fail); any other call prints a version, so tool detection stays quick.
 */
export async function headlessPath(work, path) {
  const bin = join(work, 'headless-bin');
  await mkdir(bin, { recursive: true });
  if (windows) {
    await writeFile(
      join(bin, 'codex.cmd'),
      [
        '@echo off',
        'if not "%~1"=="exec" goto version',
        'if "%SMOKE_CODEX%"=="fail" goto fail',
        'echo fake-codex exec in %CD%',
        'echo fake-codex read-only=%TAIGENT_READ_ONLY%',
        'ping -n 600 127.0.0.1 >nul',
        'exit /b 0',
        ':fail',
        'echo fake-codex: error: smoke failure',
        'exit /b 3',
        ':version',
        'echo codex-cli 0.0.0-fake',
        '',
      ].join('\r\n'),
    );
  } else {
    await writeFile(
      join(bin, 'codex'),
      [
        '#!/bin/sh',
        '[ "$1" = exec ] || { echo codex-cli 0.0.0-fake; exit 0; }',
        '[ "$SMOKE_CODEX" = fail ] && { echo "fake-codex: error: smoke failure"; exit 3; }',
        'echo "fake-codex exec in $PWD"',
        'echo "fake-codex read-only=$TAIGENT_READ_ONLY"',
        'sleep 600',
        '',
      ].join('\n'),
    );
    await chmod(join(bin, 'codex'), 0o755);
  }
  return [bin, path].join(delimiter);
}

/**
 * The command `run-skill --dry-run` prints for these arguments, run in `repo` like the app does. Windows PowerShell
 * writes piped output in the console's code page: switch it to UTF-8 first, or the Vietnamese request is mangled.
 */
function expectedCommand(repo, args) {
  const script = join(repo, 'tools', 'taiga', windows ? 'run-skill.ps1' : 'run-skill.sh');
  const all = [script, '--dry-run', '--output-format', 'text', ...args];
  const quoted = all.map((arg) => `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`).join(' ');
  const run = windows
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & ${quoted}; exit $LASTEXITCODE`], { cwd: repo, encoding: 'utf8' })
    : spawnSync('sh', all, { cwd: repo, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`FAILED: run-skill --dry-run ${args.join(' ')}: ${run.stdout}${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** The rows of a tab's screen, unwrapped as xterm shows them (a full row continues on the next one). */
const screenRows = (page, id) =>
  page
    .locator(`.terminal-view[data-id="${id}"] .xterm-rows`)
    .evaluate((rows) => [...rows.children].map((row) => (row.textContent ?? '').replaceAll('\u00a0', ' ')));

/** The JSON array a `--dry-run` printed in tab `id`: the rows from the one starting with `["`, joined until it parses. */
async function printedCommand(page, id) {
  const rows = await screenRows(page, id);
  const start = rows.findIndex((row) => row.trimStart().startsWith('["'));
  if (start === -1) throw new Error(`FAILED: tab ${id} shows no command; screen:\n${rows.join('\n')}`);
  let text = '';
  for (const row of rows.slice(start)) {
    text += row;
    try {
      return JSON.parse(text.trim());
    } catch {
      // the command continues on the next row
    }
  }
  throw new Error(`FAILED: tab ${id} shows no complete command; screen:\n${rows.join('\n')}`);
}

/** Clicks `selector` (after `before`, e.g. filling a dialog), then waits for the `skill` tab it opens to end. */
async function runButton(page, selector, before) {
  const count = await page.locator('.terminal-tab').count();
  await page.click(selector);
  if (before) await before();
  await page.waitForFunction((n) => document.querySelectorAll('.terminal-tab').length === n + 1, count);
  const tab = page.locator('.terminal-tab.active');
  if ((await tab.getAttribute('data-kind')) !== 'skill') throw new Error(`FAILED: ${selector} did not open a skill tab`);
  return { id: await tab.getAttribute('data-id'), pid: Number(await tab.getAttribute('data-pid')), title: await tab.locator('.terminal-tab-title').textContent() };
}

const ended = (page, id) => page.waitForSelector(`.terminal-tab[data-id="${id}"].exited`, { timeout: 60_000 });

export async function smokeHeadless(page, { app, repo, project, work, shots, log, check, goTo }) {
  const settingsFile = join(work, 'user-data', 'settings.json');
  await goTo(page, 'settings');
  check((await page.isChecked('input[name="headless-agent"][value="claude"]')) && (await page.textContent('#agent-name')) === 'claude', 'Settings: the headless buttons use claude by default');
  await goTo(page, 'backlog');
  // A taller panel shows a whole command (the claude one carries the allowlist).
  await page.evaluate(() => document.getElementById('terminal-dock')?.style.setProperty('--terminal-height', '520px'));
  // The spec picker answers with a file of this repository; the folder picker of later steps is put back afterwards.
  await app.evaluate(({ dialog }, file) => {
    globalThis.smokeOpenDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, join(repo, 'docs', 'headless.md'));

  const runs = [
    { selector: '#agent-plan-spec', agent: 'claude', skill: 'taiga-plan-backlog', mentions: ['Spec: docs/headless.md.', `Project: ${project}.`] },
    { selector: '#agent-review', agent: 'claude', skill: 'taiga-plan-backlog', mentions: ['review.yaml', project] },
    { selector: '#agent-story', agent: 'codex', skill: 'taiga-create-user-story', mentions: ['Người duyệt muốn lọc các story đã đổi sau khi duyệt', `Project: ${project}.`] },
  ];
  for (const run of runs) {
    if (run.agent === 'codex') {
      await goTo(page, 'settings');
      await page.check('input[name="headless-agent"][value="codex"]');
      await page.waitForFunction(() => document.getElementById('agent-name')?.textContent === 'codex');
      const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
      check(saved.headlessAgent === 'codex' && typeof saved.lastRepo === 'string', `Settings: codex saved in settings.json, next to lastRepo (${JSON.stringify(saved)})`);
      await goTo(page, 'backlog');
    }
    const fill = run.selector === '#agent-story'
      ? async () => {
          await page.fill('#story-description', run.mentions[0]);
          await page.click('#story-submit');
        }
      : undefined;
    const tab = await runButton(page, run.selector, fill);
    await ended(page, tab.id);
    await page.waitForSelector('#agent-status[data-state="ok"]');
    const shown = await printedCommand(page, tab.id);
    const prompt = run.agent === 'claude' ? shown[2] : shown.at(-1);
    const marker = run.agent === 'claude' ? `/${run.skill} ` : `$${run.skill} `;
    check(typeof prompt === 'string' && prompt.startsWith(marker), `${run.selector}: ${run.agent} runs ${run.skill} (${tab.title})`);
    const request = prompt.slice(marker.length);
    check(run.mentions.every((text) => request.includes(text)) && request.includes('không chạy apply, upload hay bootstrap'), `${run.selector}: the request names ${run.mentions.join(', ')} and forbids apply/upload/bootstrap`);
    const expected = expectedCommand(repo, [run.agent, run.skill, request]);
    const differs = expected.findIndex((arg, index) => arg !== shown[index]);
    if (differs !== -1 || shown.length !== expected.length) log(`differs at ${differs}:`, JSON.stringify(shown[differs]), 'expected', JSON.stringify(expected[differs]));
    check(JSON.stringify(shown) === JSON.stringify(expected), `${run.selector}: the tab shows exactly the command of run-skill --dry-run (${shown.length} arguments, allowlist included)`);
    log(`${run.selector} status:`, (await page.textContent('#agent-status'))?.trim());
    await page.screenshot({ path: join(shots, `headless-${run.selector.slice(7)}.png`) });
  }
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis.smokeOpenDialog;
  });

  // Huỷ: a real run (no --dry-run) of the fake codex, which waits; the tab kills its tree and says so.
  await app.evaluate(() => {
    delete process.env.TAIGENT_RUN_SKILL_DRY_RUN;
  });
  const long = await runButton(page, '#agent-review');
  const rows = (id) => page.locator(`.terminal-view[data-id="${id}"] .xterm-rows`).evaluate((view) => (view.textContent ?? '').replaceAll('\u00a0', ' '));
  await page.waitForFunction((id) => document.querySelector(`.terminal-view[data-id="${id}"] .xterm-rows`)?.textContent?.includes('fake-codex read-only='), long.id, { timeout: 60_000 });
  const printed = (await rows(long.id)).match(/fake-codex read-only=.{0,20}/)?.[0];
  check(printed?.startsWith('fake-codex read-only=1') ?? false, `the agent of a headless run gets TAIGENT_READ_ONLY=1, so its taigent refuses writes to Taiga (${printed})`);
  check(await page.isDisabled('#agent-story'), 'the buttons wait while a run goes on');
  const tree = descendants(long.pid);
  await page.click(`.terminal-tab[data-id="${long.id}"] .terminal-cancel`);
  await ended(page, long.id);
  check((await page.getAttribute(`.terminal-tab[data-id="${long.id}"]`, 'data-cancelled')) === 'true', 'Huỷ ends the run as cancelled');
  await page.waitForFunction((id) => document.querySelector(`.terminal-view[data-id="${id}"] .xterm-rows`)?.textContent?.includes('Đã huỷ lần chạy'), long.id);
  log('ok - the tab says the run was cancelled');
  await page.waitForSelector('#agent-status[data-state="cancelled"]');
  const left = await waitGone([long.pid, ...tree.keys()]);
  check(left.length === 0, `Huỷ killed the run's process tree (${[long.pid, ...tree.values()].join(', ')})`);
  await page.screenshot({ path: join(shots, 'headless-cancelled.png') });

  // A failing run: exit code and last error line.
  await app.evaluate(() => {
    process.env.SMOKE_CODEX = 'fail';
  });
  const failing = await runButton(page, '#agent-review');
  await ended(page, failing.id);
  await page.waitForSelector('#agent-status[data-state="error"]');
  const status = (await page.textContent('#agent-status')) ?? '';
  check(status.includes('mã thoát 3') && status.includes('fake-codex: error: smoke failure'), `a failed run shows its exit code and last error line (${status.trim()})`);
  await page.screenshot({ path: join(shots, 'headless-failed.png') });
  await app.evaluate(() => {
    delete process.env.SMOKE_CODEX;
  });
  // Later steps get the panel as the terminal steps left it: default height, hidden.
  await page.evaluate(() => document.getElementById('terminal-dock')?.style.removeProperty('--terminal-height'));
  await page.click('#terminal-hide');
}

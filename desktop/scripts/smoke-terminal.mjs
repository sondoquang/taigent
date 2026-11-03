// Terminal steps of the desktop smoke (scripts/smoke.mjs): the panel toggles, a shell tab runs commands in the
// repository (output, Vietnamese, colours, size after resizing the panel), closing a tab kills its process tree, the
// + menu filters by its search box and opens each shell of the machine (on Windows also Command Prompt and, when
// installed, Git Bash, both in the repository) and starts the agent in the repository (a fake `claude` put first on
// PATH) or shows the shell's error when it is missing (`omp` taken off PATH), and quitting leaves no process of the
// app behind.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const windows = process.platform === 'win32';
const COMMANDS = windows
  ? {
      echo: 'Write-Output ("smoke-" + (6*7))',
      vietnamese: 'Write-Output ("Tiếng " + "Việt: đã chạy")',
      colour: 'Write-Output ("$([char]27)[31m" + "red" + "-ok$([char]27)[0m")',
      size: 'Write-Output ("size-" + [Console]::WindowWidth + "x" + [Console]::WindowHeight)',
      longRunning: 'ping -n 600 127.0.0.1',
    }
  : {
      echo: 'echo smoke-$((6*7))',
      vietnamese: "printf 'Tiếng %s\\n' 'Việt: đã chạy'",
      colour: "printf '\\033[31m%s\\033[0m\\n' red-ok",
      size: 'echo size-$(tput cols)x$(tput lines)',
      longRunning: 'sleep 600',
    };

/**
 * The PATH the app is launched with: a folder with a fake `claude` that prints its working directory comes first,
 * and every folder that has an `omp` is left out, so the quick launch of `omp` meets a missing agent.
 */
export async function agentPath(work) {
  const bin = join(work, 'bin');
  await mkdir(bin, { recursive: true });
  if (windows) await writeFile(join(bin, 'claude.cmd'), '@echo off\r\necho fake-claude in %CD%\r\n');
  else {
    await writeFile(join(bin, 'claude'), '#!/bin/sh\necho "fake-claude in $PWD"\n');
    await chmod(join(bin, 'claude'), 0o755);
  }
  const hasOmp = (dir) => ['', '.exe', '.cmd', '.bat', '.ps1'].some((ext) => existsSync(join(dir, `omp${ext}`)));
  const kept = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && !hasOmp(dir));
  return [bin, ...kept].join(delimiter);
}

/**
 * Every process under `root` (pid → name), from one process listing. Windows keeps the parent pid of a process
 * whose parent has exited, and pids are reused: a child must have started after its parent.
 */
export function descendants(root) {
  const rows = windows
    ? execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $([long]$_.CreationDate.Ticks) $($_.Name)" }'], { encoding: 'utf8', windowsHide: true })
    : execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).replace(/^(\s*\d+\s+\d+)/gm, '$1 0');
  const children = new Map();
  const started = new Map();
  for (const line of rows.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const [pid, ppid, ticks] = match.slice(1, 4).map(Number);
    started.set(pid, ticks);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push({ pid, ticks, name: match[4].trim() });
  }
  const found = new Map();
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (found.has(child.pid) || child.pid === root || child.ticks < (started.get(parent) ?? 0)) continue;
      found.set(child.pid, child.name);
      queue.push(child.pid);
    }
  }
  return found;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

/** Waits until none of `pids` runs; returns those still running after `timeout`. */
export async function waitGone(pids, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let left = [...pids].filter(alive);
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    left = left.filter(alive);
  }
  return left;
}

const screenText = (page, id) =>
  page
    .locator(`.terminal-view[data-id="${id}"] .xterm-rows`)
    .evaluate((rows) => [...rows.children].map((row) => (row.textContent ?? '').replaceAll('\u00a0', ' ').trimEnd()).join('\n'));

async function waitForText(page, id, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let text = '';
  while (Date.now() < deadline) {
    text = await screenText(page, id);
    const match = typeof pattern === 'string' ? (text.includes(pattern) ? [pattern] : null) : pattern.exec(text);
    if (match) return match;
    await page.waitForTimeout(200);
  }
  throw new Error(`FAILED: terminal tab ${id} never showed ${pattern}; screen:\n${text}`);
}

async function run(page, id, command) {
  await page.click(`.terminal-view[data-id="${id}"] .xterm-screen`);
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/** Picks `item` in the + menu, then returns the new tab that becomes active: its id, process id and kind. */
async function openTab(page, item, kind) {
  const before = await page.locator('.terminal-tab').count();
  await page.click('#terminal-new');
  await page.click(`#terminal-menu ${item}`);
  if (await page.isVisible('#terminal-menu')) throw new Error('FAILED: the + menu stays open after picking an entry');
  await page.waitForFunction((count) => document.querySelectorAll('.terminal-tab').length === count + 1, before);
  const tab = page.locator('.terminal-tab.active');
  const opened = { id: await tab.getAttribute('data-id'), pid: Number(await tab.getAttribute('data-pid')), kind: await tab.getAttribute('data-kind') };
  if (opened.kind !== kind) throw new Error(`FAILED: ${item} opened a ${opened.kind} tab, not ${kind}`);
  await page.waitForFunction((tabId) => (document.querySelector(`.terminal-view[data-id="${tabId}"] .xterm-rows`)?.textContent ?? '').trim() !== '', opened.id, { timeout: 30_000 });
  return opened;
}

/** Opens shell `shell` from the + menu, runs `command` and waits for `pattern`; closes the tab. */
async function tryShell(page, shell, command, pattern) {
  const tab = await openTab(page, `[data-launch="shell"][data-shell="${shell}"]`, 'shell');
  await run(page, tab.id, command);
  const match = await waitForText(page, tab.id, pattern);
  await page.click(`.terminal-tab[data-id="${tab.id}"] .terminal-close`);
  await page.waitForSelector(`.terminal-tab[data-id="${tab.id}"]`, { state: 'detached' });
  return match;
}

export async function smokeTerminal(page, { repo, shots, log, check }) {
  const dockShown = () => page.isVisible('#terminal-dock');
  check(!(await dockShown()), 'terminal panel is hidden by default');
  await page.keyboard.press('Control+Backquote');
  check(await dockShown(), 'Ctrl+` shows the terminal panel');
  await page.keyboard.press('Control+Backquote');
  check(!(await dockShown()), 'Ctrl+` hides it again');
  await page.click('#terminal-toggle');
  check(await dockShown(), 'the Terminal button shows it');

  const shell = await openTab(page, '[data-launch="shell"]', 'shell');
  log('shell tab', JSON.stringify(shell));
  await run(page, shell.id, COMMANDS.echo);
  await waitForText(page, shell.id, 'smoke-42');
  log('ok - shell tab ran a command and shows its output');
  await run(page, shell.id, COMMANDS.vietnamese);
  await waitForText(page, shell.id, 'Tiếng Việt: đã chạy');
  log('ok - Vietnamese shows as typed and printed');
  await run(page, shell.id, COMMANDS.colour);
  await waitForText(page, shell.id, 'red-ok');
  const red = await page
    .locator(`.terminal-view[data-id="${shell.id}"] .xterm-rows span`)
    .evaluateAll((spans) => spans.some((span) => span.textContent?.includes('red-ok') && /\bxterm-fg-(1|9)\b/.test(span.className)));
  check(red, 'ANSI red shows in red');

  const rowsBefore = Number(await page.getAttribute(`.terminal-view[data-id="${shell.id}"]`, 'data-rows'));
  const handle = await page.locator('#terminal-resizer').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y - 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    ([id, rows]) => Number(document.querySelector(`.terminal-view[data-id="${id}"]`)?.getAttribute('data-rows')) > rows,
    [shell.id, rowsBefore],
  );
  const cols = await page.getAttribute(`.terminal-view[data-id="${shell.id}"]`, 'data-cols');
  const rows = await page.getAttribute(`.terminal-view[data-id="${shell.id}"]`, 'data-rows');
  await run(page, shell.id, COMMANDS.size);
  const [, ptyCols, ptyRows] = await waitForText(page, shell.id, /size-(\d+)x(\d+)/);
  check(ptyCols === cols && ptyRows === rows, `after resizing the panel (${rowsBefore} → ${rows} rows) the shell sees ${ptyCols}x${ptyRows} = ${cols}x${rows}`);

  await page.keyboard.press('Control+Backquote');
  check(!(await dockShown()), 'Ctrl+` hides the panel while the terminal has the focus');
  await page.keyboard.press('Control+Backquote');
  check(await dockShown(), 'Ctrl+` shows it again');

  await run(page, shell.id, COMMANDS.longRunning);
  let tree = new Map();
  for (const deadline = Date.now() + 15_000; tree.size === 0 && Date.now() < deadline; ) {
    await page.waitForTimeout(300);
    tree = descendants(shell.pid);
  }
  check(tree.size > 0, `shell runs a child process (${[...tree.values()].join(', ')})`);
  await page.screenshot({ path: join(shots, 'terminal-1-shell.png') });
  await page.click(`.terminal-tab[data-id="${shell.id}"] .terminal-close`);
  await page.waitForSelector(`.terminal-tab[data-id="${shell.id}"]`, { state: 'detached' });
  const left = await waitGone([shell.pid, ...tree.keys()]);
  check(left.length === 0, `closing the tab stopped the shell and its children (${[shell.pid, ...tree.keys()].join(', ')})`);

  await page.click('#terminal-new');
  const menuEntries = () => page.$$eval('#terminal-menu [role="menuitem"]', (items) => items.map((item) => item.dataset.shell ?? item.dataset.launch ?? item.textContent));
  const all = await menuEntries();
  log('+ menu', JSON.stringify(all));
  check(['claude', 'codex', 'omp'].every((agent) => all.includes(agent)) && all.length >= 5, 'the + menu lists the shells, the agents and Cài đặt agent');
  await page.screenshot({ path: join(shots, 'terminal-2-menu.png') });
  await page.fill('#terminal-menu-search', 'codex');
  check((await menuEntries()).join() === 'codex', 'the + menu search keeps only the matching entries');
  await page.fill('#terminal-menu-search', 'cai dat');
  check((await menuEntries()).length === 1, 'the search ignores Vietnamese diacritics (cai dat → Cài đặt agent…)');
  await page.keyboard.press('Escape');
  check(!(await page.isVisible('#terminal-menu')), 'Escape closes the + menu');
  if (windows) {
    check(all.includes('cmd'), 'Windows offers Command Prompt');
    await tryShell(page, 'cmd', 'set /a 6*7+1000', /^1042$/m);
    log('ok - a Command Prompt tab runs commands');
    if (all.includes('git-bash')) {
      const [, at] = await tryShell(page, 'git-bash', 'echo "bash-$((6*7)) in $(pwd -W)"', /bash-42 in (.+)/);
      check(at.trim().replaceAll('/', '\\').toLowerCase() === repo.toLowerCase(), `a Git Bash tab starts in the repository (${at.trim()})`);
    } else log('skip - Git Bash is not installed');
  }

  const claude = await openTab(page, '[data-launch="claude"]', 'claude');
  const [, cwd] = await waitForText(page, claude.id, /fake-claude in (.+)/);
  check(cwd.trim().toLowerCase() === repo.toLowerCase(), `quick launch runs claude in the repository (${cwd.trim()})`);
  check((await page.textContent('.terminal-tab.active .terminal-tab-title')) === 'claude', 'the tab is named claude');

  const omp = await openTab(page, '[data-launch="omp"]', 'omp');
  await waitForText(page, omp.id, /omp.*(not recognized|not found)|(not recognized|not found).*omp/i);
  check(!(await page.locator(`.terminal-tab[data-id="${omp.id}"]`).getAttribute('class'))?.includes('exited'), 'a missing agent shows the shell error and the tab keeps its shell');
  check((await page.evaluate(() => document.querySelectorAll('.terminal-tab').length)) === 2, 'the app still runs (2 tabs open)');
  await page.screenshot({ path: join(shots, 'terminal-2-agents.png') });

  // Left running for the quit check: a shell with a child process.
  const busy = await openTab(page, '[data-launch="shell"]', 'shell');
  await run(page, busy.id, COMMANDS.longRunning);
  await page.click('#terminal-hide');
  check(!(await dockShown()), 'the Ẩn button hides the panel; its tabs keep running');
}

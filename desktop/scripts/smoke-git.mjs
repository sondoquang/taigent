// Smoke step of the Git section (spec #35 §Git, ticket #48), run by smoke.mjs once the main walk is done. It builds a
// temporary repository cloned from a temporary bare remote, holding the fixture under `taiga/<slug>/`, a docs.yaml
// that references `docs/huong-dan.md`, and a file outside both. It then opens that repository in the app and checks:
//   - the section lists only the changed files in `taiga/` and those docs.yaml references;
//   - Commit + Push sends the remote exactly the changed file under `taiga/`, never the file outside it;
//   - Pull on a diverged history stops, explains, opens the repository (the terminal hook) and changes nothing.
// The app's process env loses TAIGENT_MANIFESTS_DIR for this step, so the manifests are the repository's `taiga/`.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

export async function smokeGit({ app, page, work, project, source, shots, check, goTo, log }) {
  const base = join(work, 'git');
  const remote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  const teammate = join(base, 'teammate');
  await mkdir(repo, { recursive: true });
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  for (const [cwd, ...args] of [
    [repo, 'init', '--quiet', '--initial-branch=main'],
    [repo, 'config', 'user.name', 'Taigent Smoke'],
    [repo, 'config', 'user.email', 'smoke@example.invalid'],
    [repo, 'config', 'core.autocrlf', 'false'],
  ]) git(cwd, ...args);
  await cp(source, join(repo, 'taiga', project), { recursive: true });
  await writeFile(join(repo, 'taiga', project, 'docs.yaml'), 'wiki:\n  - slug: huong-dan\n    file: ../../docs/huong-dan.md\n');
  await mkdir(join(repo, 'docs'));
  await writeFile(join(repo, 'docs', 'huong-dan.md'), '# Hướng dẫn\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'app.txt'), 'code\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'chore: seed');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '--quiet', '--set-upstream', 'origin', 'main');

  const backlog = join('taiga', project, 'backlog.yaml');
  await app.evaluate(({ dialog, shell }, root) => {
    delete process.env.TAIGENT_MANIFESTS_DIR;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    // The terminal hook: record what the app opens instead of opening a window.
    globalThis.smokeOpened = [];
    shell.openPath = async (path) => {
      globalThis.smokeOpened.push(path);
      return '';
    };
  }, repo);
  const opened = () => app.evaluate(() => globalThis.smokeOpened);
  const result = async () => (await page.textContent('#git-result')) ?? '';
  const waitResult = async (before) => {
    await page.waitForFunction((previous) => {
      const text = document.querySelector('#git-result')?.textContent ?? '';
      return text !== previous && !text.includes('Đang chạy');
    }, before, { timeout: 60_000 });
    return result();
  };

  await page.click('#open-repo');
  await goTo(page, 'git');
  await page.waitForFunction(() => document.querySelector('#git-overview')?.textContent?.includes('main'), null, { timeout: 30_000 });
  check((await page.locator('#git-files li').count()) === 0, 'git: a clean repository lists no changed file');

  // One change inside taiga/, one outside: only the first is listed and pushed.
  await writeFile(join(repo, backlog), `${await readFile(join(repo, backlog), 'utf8')}# smoke: sửa trong taiga/\n`);
  await writeFile(join(repo, 'src', 'app.txt'), 'code đang sửa dở\n');
  await page.click('#git-refresh');
  await page.waitForSelector('#git-files li');
  const listed = await page.locator('#git-files li').evaluateAll((items) => items.map((item) => item.dataset.path));
  check(listed.join('|') === backlog.replaceAll('\\', '/'), `git: lists only ${listed.join(', ')}`);
  check((await page.textContent('#git-outside'))?.includes('1'), 'git: reports one changed file outside the scope');
  await page.screenshot({ path: join(shots, 'git-1-status.png') });

  await page.fill('#git-message', 'docs(taiga): smoke commit');
  const beforeCommit = await result();
  await page.click('#git-commit-push');
  const committed = await waitResult(beforeCommit);
  check(committed.includes('Đã commit và push'), `git: commit + push succeeded (${committed.trim().slice(0, 80)})`);
  const pushed = git(remote, 'log', '-1', '--name-only', '--format=%s').split('\n').filter(Boolean);
  check(pushed[0] === 'docs(taiga): smoke commit', 'git: the remote has the commit with its message');
  check(pushed.slice(1).join('|') === backlog.replaceAll('\\', '/'), `git: the remote received only ${pushed.slice(1).join(', ')}`);
  check(git(repo, 'status', '--porcelain').includes('src/app.txt'), 'git: the file outside taiga/ is still uncommitted');
  await page.screenshot({ path: join(shots, 'git-2-pushed.png') });

  // A file docs.yaml references, outside taiga/, is in scope too.
  await writeFile(join(repo, 'docs', 'huong-dan.md'), '# Hướng dẫn\n\nĐã sửa.\n');
  await page.click('#git-refresh');
  await page.waitForSelector('#git-files li[data-path="docs/huong-dan.md"]');
  log('ok - git: lists docs/huong-dan.md, which docs.yaml references');

  // Diverged history: a teammate pushes, a local commit exists. Pull stops, explains, opens the repository.
  git(base, 'clone', '--quiet', remote, teammate);
  git(teammate, 'config', 'user.name', 'Teammate');
  git(teammate, 'config', 'user.email', 'teammate@example.invalid');
  git(teammate, 'config', 'core.autocrlf', 'false');
  await writeFile(join(teammate, 'taiga', project, 'review.yaml'), 'items: {}\n');
  git(teammate, 'add', '--all');
  git(teammate, 'commit', '--quiet', '-m', 'docs(taiga): teammate');
  git(teammate, 'push', '--quiet');
  git(repo, 'commit', '--quiet', '-m', 'chore: local work', '--', 'src/app.txt');
  const head = git(repo, 'rev-parse', 'HEAD');
  const status = git(repo, 'status', '--porcelain');
  const guide = await readFile(join(repo, 'docs', 'huong-dan.md'), 'utf8');
  const beforePull = await result();
  await page.click('#git-pull');
  const stopped = await waitResult(beforePull);
  check(stopped.includes('tách nhánh'), `git: pull on a diverged history explains it (${stopped.trim().slice(0, 80)})`);
  check((await opened()).includes(repo), 'git: the repository is opened for the terminal');
  check(git(repo, 'rev-parse', 'HEAD') === head, 'git: HEAD unchanged after the refused pull');
  check(git(repo, 'status', '--porcelain') === status, 'git: working tree status unchanged after the refused pull');
  check((await readFile(join(repo, 'docs', 'huong-dan.md'), 'utf8')) === guide, 'git: working tree files unchanged after the refused pull');
  await page.screenshot({ path: join(shots, 'git-3-diverged.png') });
}

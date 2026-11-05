// Smoke step of the Product Owner dashboard (spec #64 Seam 3, ticket #71), run by smoke-dashboard.mjs once the Role
// menu picked Product Owner, against the same FakeTaiga project (never the real Taiga). It puts the seeded stories in
// the two sprints, tags them with releases and declares releases in the temporary project.yaml (restored afterwards),
// reads again, and checks:
//   - health: four signals, each with its colour and a reason in Vietnamese;
//   - the current sprint against its ideal line, velocity, planned vs completed labelled by its basis (sprint start),
//     and the scope change of each sprint, rebuilt from the stories' sprint changes;
//   - the release burndowns: a declared release with an ideal line, an undeclared tag drawn without one, a declared
//     release without stories, and a story with two release tags left out, all three warned about;
//   - the bug trend, and the sprint and epic tables that the Taiga section no longer shows;
//   - a kanban project (Backlog module off): no sprint widgets, a note saying why.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The local day `offset` days from today, YYYY-MM-DD. */
function day(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Sprints, release tags and an epic on the stories smoke-dashboard.mjs seeded; no item is added or removed. "Trang hồ
 * sơ" (created 5 days ago) and "Chưa ai nhận" (3 days ago) were created after Sprint 2 started, "Đổi mật khẩu" (8 days
 * ago) after Sprint 1 did: scope added. "Chưa ai nhận" was then taken out of Sprint 2 yesterday: scope removed.
 */
function plan(fake, slug) {
  const project = fake.state.projects.find((candidate) => candidate.slug === slug);
  const sprint = (name) => fake.state.milestones.find((milestone) => milestone.project === project.id && milestone.name === name);
  const story = (subject) => fake.state.userStories.find((candidate) => candidate.project === project.id && candidate.subject === subject);
  const now = new Date().toISOString();
  const set = (subject, changes) => Object.assign(story(subject), { ...changes, modified_date: now });
  const sso = set('Đăng nhập SSO', { milestone: sprint('Sprint 2').id, tags: ['release:v1-0-0'] });
  const profile = set('Trang hồ sơ', { milestone: sprint('Sprint 2').id, tags: ['release:v1-0-0'] });
  const password = set('Đổi mật khẩu', { milestone: sprint('Sprint 1').id, tags: ['release:v1-0-0', 'release:v2-0-0'] });
  const unclaimed = set('Chưa ai nhận', { tags: ['release:v3-0-0'] });
  fake.addMilestoneChange(unclaimed, { at: new Date(`${day(-1)}T12:00:00`).toISOString(), from: sprint('Sprint 2'), to: null });
  const epic = fake.addEpic({ project: project.id, subject: 'Đăng nhập' });
  fake.addEpicRelatedUserStory(epic, sso);
  fake.addEpicRelatedUserStory(epic, password);
  return { project, sso, profile, password, unclaimed, epic };
}

export async function smokeProductOwner({ page, fake, work, project, shots, check, log, refresh }) {
  const projectFile = join(work, 'taiga', project, 'project.yaml');
  const original = await readFile(projectFile, 'utf8');
  const signals = () =>
    page.locator('#dashboard-health [data-signal]').evaluateAll((items) => items.map((item) => ({ signal: item.dataset.signal, level: item.dataset.level, reason: item.querySelector('.reason')?.textContent ?? '' })));
  const stats = (selector) =>
    page.locator(`${selector} .stat`).evaluateAll((cells) => Object.fromEntries(cells.map((cell) => [cell.querySelector('span')?.textContent ?? '', cell.querySelector('strong')?.textContent ?? ''])));
  const attributes = (selector, name) => page.locator(selector).evaluateAll((items, attribute) => items.map((item) => item.getAttribute(attribute)), name);
  try {
    const { project: taiga, sso, unclaimed, epic } = plan(fake, project);
    await writeFile(
      projectFile,
      `${original.trimEnd()}\nreleases:\n  - version: v1-0-0\n    target: ${day(14)}\n  - version: v0-9-0\n    target: ${day(30)}\n`,
    );
    await refresh();
    await page.waitForSelector('#dashboard-product-owner[data-cadence="sprint"]');
    check(!(await page.isVisible('#dashboard-failure')), 'dashboard PO: the metrics with releases declared in project.yaml are read');

    // Health: Sprint 2 holds 8 points, none done on day 6 of 13 (red); 1 story and 1 task overdue (yellow); open bugs
    // did not rise (green); 1 blocked story (yellow).
    const health = await signals();
    const levels = Object.fromEntries(health.map((entry) => [entry.signal, entry.level]));
    check(
      JSON.stringify(levels) === JSON.stringify({ sprintPace: 'red', overdue: 'yellow', openBugs: 'green', blocked: 'yellow' }),
      `dashboard PO: health has the four signals with their colour (${JSON.stringify(levels)})`,
    );
    const reasons = Object.fromEntries(health.map((entry) => [entry.signal, entry.reason]));
    check(
      reasons.sprintPace.includes('Sprint 2 chậm') && reasons.overdue.startsWith('1 story và 1 task') && reasons.blocked.startsWith('1 user story'),
      `dashboard PO: each signal says why, in Vietnamese (${health.map((entry) => entry.reason).join(' | ')})`,
    );

    const sprint = await stats('#dashboard-sprint');
    check(
      sprint['Point xong / tổng'] === '0/8' && sprint['Story xong / tổng'] === '0/2' && sprint['Ngày đã qua / tổng'] === '6/13',
      `dashboard PO: the current sprint's progress and days (${JSON.stringify(sprint)})`,
    );
    check(await page.isVisible('#dashboard-sprint [data-slot="chart"] .recharts-surface'), 'dashboard PO: the current sprint is drawn against its ideal line');
    check((await page.getAttribute('#dashboard-velocity [data-slot="chart"]', 'data-series')) === '2', 'dashboard PO: velocity is the points closed in the closed sprint');

    // Planned at sprint start: Sprint 1 had no story on its first day (Đổi mật khẩu came later, 2 points closed),
    // Sprint 2 only Đăng nhập SSO (3 points).
    const basis = await page.getAttribute('#dashboard-planned-basis', 'data-basis');
    const basisText = (await page.textContent('#dashboard-planned-basis')) ?? '';
    const planned = (await page.getAttribute('#dashboard-planned [data-slot="chart"]', 'data-series')) ?? '';
    check(
      basis === 'sprint-start' && basisText.includes('ngày sprint bắt đầu') && planned === '0/2,3/0',
      `dashboard PO: planned (at sprint start) vs completed per sprint, labelled by its basis "${basis}" (${planned})`,
    );
    // Scope change, added/removed points per sprint: Sprint 1 +2; Sprint 2 +5 +8, then -8.
    const scope = await page.locator('#dashboard-scope tr[data-period]').evaluateAll((rows) => rows.map((row) => `${row.dataset.added}/${row.dataset.removed}`));
    const scopeText = (await page.textContent('#dashboard-scope')) ?? '';
    check(
      scope.join('|') === '2/0|13/8' && scopeText.includes(`#${unclaimed.ref} ${unclaimed.subject}`) && scopeText.includes('Rút ra'),
      `dashboard PO: scope change per sprint with the stories added and taken out (${scope.join(', ')})`,
    );

    // Release burndown: v1-0-0 declared with 2 stories, v0-9-0 declared without any, v3-0-0 tagged but not declared;
    // "Đổi mật khẩu" carries two release tags and is in none.
    const releases = await page
      .locator('#dashboard-release section[data-release]')
      .evaluateAll((items) => items.map((item) => `${item.dataset.release}:${item.dataset.declared}:${item.dataset.stories}:${item.querySelectorAll('.recharts-line').length}`));
    check(releases.join('|') === 'v1-0-0:true:2:2|v0-9-0:true:0:0|v3-0-0:false:1:1', `dashboard PO: release burndowns, the undeclared one without an ideal line (${releases.join(', ')})`);
    const warnings = await attributes('#dashboard-release-warnings [data-warning]', 'data-warning');
    check(warnings.join('|') === 'release-undeclared|release-empty|release-multiple', `dashboard PO: the three release warnings (${warnings.join(', ')})`);
    const warningText = (await page.textContent('#dashboard-release-warnings')) ?? '';
    check(warningText.includes('release:v3-0-0') && warningText.includes('Đổi mật khẩu') && warningText.includes('Cách sửa'), 'dashboard PO: the warnings name the tag, the story and the fix');

    check(await page.isVisible('#dashboard-bug-trend [data-slot="chart"] .recharts-surface'), 'dashboard PO: the bug trend is a chart');
    check((await attributes('#dashboard-bug-trend tr[data-period]', 'data-period')).length === 2, 'dashboard PO: the bug trend has one row per sprint');

    // The tables of the former Taiga > Báo cáo card.
    const sprints = await attributes('#dashboard-report-sprints tr[data-sprint]', 'data-sprint');
    const epics = await attributes('#dashboard-report-epics tr[data-epic]', 'data-epic');
    const outside = await attributes('#dashboard-report-outside tr[data-story]', 'data-story');
    check(sprints.length === 2 && epics.join('|') === `${epic.ref}|none` && outside.join('|') === String(unclaimed.ref), `dashboard PO: the sprint and epic tables and the stories in no sprint (${sprints.length} sprints, epics ${epics.join(', ')}, outside ${outside.join(', ')})`);
    const blockedCell = (await page.textContent(`#dashboard-report-sprints tr[data-sprint="${sso.milestone}"]`)) ?? '';
    check(blockedCell.includes(`#${sso.ref} ${sso.subject}`), 'dashboard PO: the sprint table lists its blocked story');
    await page.screenshot({ path: join(shots, 'dashboard-4-product-owner.png'), fullPage: true });

    // A kanban project: no sprint widgets, and why.
    taiga.modules.is_backlog_activated = false;
    await refresh();
    await page.waitForSelector('#dashboard-product-owner[data-cadence="week"]');
    check(
      (await page.isVisible('#dashboard-po-kanban')) && (await page.locator('#dashboard-sprint, #dashboard-velocity, #dashboard-planned, #dashboard-scope').count()) === 0 && (await signals()).every((entry) => entry.signal !== 'sprintPace'),
      'dashboard PO: a kanban project has no sprint widgets nor sprint pace, and a note says why',
    );
    log('dashboard PO kanban note:', (await page.textContent('#dashboard-po-kanban'))?.trim());
    taiga.modules.is_backlog_activated = true;
  } finally {
    await writeFile(projectFile, original);
  }
  await refresh();
}

// Smoke step of the Business Analyst dashboard (spec #64 Seam 3, ticket #72), run by smoke-dashboard.mjs with the
// Business Analyst Role picked and the CLI pointed at FakeTaiga. The CLI reads the manifests of a copy of the fixture
// made here (TAIGENT_MANIFESTS_DIR of the app's process env, put back before it returns), so the open project and its
// watcher never see these edits:
//   1. The copy holds a story whose only scenario misses its Then (its epic is then uncovered), a review.yaml with a
//      stale verdict, an open and a resolved comment, and a state.json that records one story on the fake Taiga and one
//      gone from it. The dashboard shows the stories on Taiga by status (New read as "đang phân tích", Ready as "đủ AC")
//      with "Chưa apply", the requirements coverage with the uncovered epic, the stories without complete acceptance
//      criteria and why, the items awaiting review and those pending clarification.
//   2. Without a backlog manifest the statuses stay and a note says why the other metrics are missing.

import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AT = '2026-11-02T09:30:00.000Z';

const REVIEW = `items:
  REVIEW-APPROVE:
    verdict: approved
    digest: not-the-current-digest
  PUSH-BLOCK:
    comments:
      - { id: c1, by: lan, at: "${AT}", text: "Góp ý của PO có chặn đẩy không?", resolved: false }
  PUSH-CONFIRM:
    comments:
      - { id: c1, by: lan, at: "${AT}", text: "Đã rõ", resolved: true }
`;

/**
 * @param {object} step
 * @param {{ id: number, ref: number }} step.onTaiga a story of the fake project, recorded in state.json as REVIEW-MARKDOWN
 */
export async function smokeBusinessAnalyst({ app, page, work, project, shots, check, refresh, stats, setEnv, onTaiga }) {
  const ba = '#dashboard-business-analyst';
  /** `data-item` (and `data-reason` when present) of each row under `selector`. */
  const items = (selector) =>
    page.locator(`${selector} tr[data-item]`).evaluateAll((rows) => rows.map((row) => [row.dataset.item, row.dataset.reason].filter(Boolean).join(':')));
  const statusCount = (status) => page.textContent(`#dashboard-ba-statuses tr[data-status="${status}"] td:last-child`);
  const statusText = async (status) => (await page.textContent(`#dashboard-ba-statuses tr[data-status="${status}"]`)) ?? '';

  const manifests = await mkdtemp(join(work, 'dashboard-ba-'));
  const copy = join(manifests, 'taiga', project);
  await cp(join(work, 'taiga', project), copy, { recursive: true });
  const backlog = await readFile(join(copy, 'backlog.yaml'), 'utf8');
  const blankThen = backlog.replace('then: "Smoke chạy hết và không file nào của tôi bị sửa"', 'then: " "');
  check(blankThen !== backlog, 'dashboard BA: the fixture story SMOKE-FIXTURE loses its Then in the copy');
  await writeFile(join(copy, 'backlog.yaml'), blankThen);
  await writeFile(join(copy, 'review.yaml'), REVIEW);
  const state = {
    items: {
      REVIEW: { type: 'epic', id: 1, ref: 1, version: 1 },
      'REVIEW-MARKDOWN': { type: 'story', id: onTaiga.id, ref: onTaiga.ref, version: 1 },
      'REVIEW-COMMENT': { type: 'story', id: 99999, ref: 999, version: 1 },
    },
  };
  await writeFile(join(copy, 'state.json'), JSON.stringify(state, null, 2));
  const empty = join(manifests, 'empty');
  await mkdir(empty);

  const [saved] = await app.evaluate(() => [process.env.TAIGENT_MANIFESTS_DIR]);
  try {
    // 1. The metrics of the backlog manifest.
    await setEnv({ TAIGENT_MANIFESTS_DIR: join(manifests, 'taiga') });
    await refresh();
    await page.waitForSelector(`${ba}[data-backlog="ok"]`);
    check(
      (await statusCount('New')) === '2' && (await statusCount('Ready')) === '0' && (await statusCount('In progress')) === '1' && (await statusCount('Done')) === '1',
      'dashboard BA: the stories on Taiga counted by status',
    );
    check((await statusText('New')).includes('đang phân tích') && (await statusText('Ready')).includes('đủ AC'), 'dashboard BA: New reads "đang phân tích", Ready reads "đủ AC"');
    // Six stories in the backlog: REVIEW-MARKDOWN is on Taiga, REVIEW-COMMENT's recorded story is gone.
    check((await statusCount('not-applied')) === '5' && (await statusText('not-applied')).includes('Chưa apply'), 'dashboard BA: the backlog stories not on Taiga are "Chưa apply"');
    check(await page.isVisible('#dashboard-ba-statuses [data-slot="chart"] .recharts-surface'), 'dashboard BA: the statuses are a chart too');

    const coverage = await stats('#dashboard-ba-coverage');
    check(coverage['Epic có story đủ AC'] === '2 / 3' && coverage['Độ phủ yêu cầu'] === '67%', `dashboard BA: requirements coverage (${JSON.stringify(coverage)})`);
    check((await items('#dashboard-ba-coverage')).join('|') === 'SMOKE', 'dashboard BA: the epic without a story with complete acceptance criteria is listed');

    const criteria = await stats('#dashboard-ba-criteria');
    check(criteria['Story đủ AC'] === '4 / 6' && criteria['Tỉ lệ đủ AC'] === '67%', `dashboard BA: complete acceptance criteria (${JSON.stringify(criteria)})`);
    check((await items('#dashboard-ba-criteria')).join('|') === 'REVIEW-MARKDOWN:legacy|SMOKE-FIXTURE:incomplete-scenarios', 'dashboard BA: the stories without complete acceptance criteria, with their reason');
    const legacy = (await page.textContent('#dashboard-ba-criteria tr[data-item="REVIEW-MARKDOWN"]')) ?? '';
    const missingThen = (await page.textContent('#dashboard-ba-criteria tr[data-item="SMOKE-FIXTURE"]')) ?? '';
    check(legacy.includes(`#${onTaiga.ref}`) && legacy.includes('legacy') && missingThen.includes('thiếu Then'), 'dashboard BA: the reasons read legacy and "thiếu Then"');
    const requirementChange = (await page.textContent(`${ba} [data-metric="businessAnalyst.requirementChange"]`)) ?? '';
    check(requirementChange.includes('Chưa có') && requirementChange.includes('history'), 'dashboard BA: requirement change is a "Chưa có" cell with its reason');

    // No verdict anywhere but REVIEW-APPROVE's stale one: the 15 items of the backlog all await review.
    const review = await items('#dashboard-ba-review');
    check(review.length === 15 && review.includes('REVIEW-APPROVE:stale') && review.includes('BUG-STALE-AFTER-RENAME:unreviewed'), `dashboard BA: the items awaiting review, stale verdict included (${review.length})`);
    check(((await page.textContent('#dashboard-ba-review h2')) ?? '').includes('(15)'), 'dashboard BA: the awaiting-review title counts them');
    check((await items('#dashboard-ba-clarification')).join('|') === 'PUSH-BLOCK', 'dashboard BA: only the item with an open comment is pending clarification');
    check(((await page.textContent('#dashboard-ba-clarification tr[data-item="PUSH-BLOCK"]')) ?? '').includes('Góp ý của PO có chặn đẩy không?'), 'dashboard BA: the open comment shows with its item');
    check((await page.locator('#dashboard-ba-backlog').count()) === 0, 'dashboard BA: no backlog note with a valid backlog manifest');
    await page.locator('#dashboard-ba-coverage').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'dashboard-ba-1-backlog.png') });

    // 2. No backlog manifest: the statuses stay, a note replaces the rest.
    await setEnv({ TAIGENT_MANIFESTS_DIR: empty });
    await refresh();
    await page.waitForSelector(`${ba}[data-backlog="backlog-missing"]`);
    const note = (await page.textContent('#dashboard-ba-backlog[data-reason="backlog-missing"]')) ?? '';
    check(note.includes('backlog.yaml') && note.includes('Chưa apply'), 'dashboard BA: without a backlog manifest a note says why its metrics are missing');
    check(
      (await statusCount('New')) === '2' && (await page.locator('#dashboard-ba-statuses tr[data-status="not-applied"]').count()) === 0,
      'dashboard BA: without a backlog manifest the statuses on Taiga stay, without "Chưa apply"',
    );
    check((await page.locator('#dashboard-ba-coverage, #dashboard-ba-criteria, #dashboard-ba-review, #dashboard-ba-clarification').count()) === 0, 'dashboard BA: the widgets of the manifest give way to the note');
    await page.locator('#dashboard-ba-backlog').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(shots, 'dashboard-ba-2-no-backlog.png') });
  } finally {
    await setEnv({ TAIGENT_MANIFESTS_DIR: saved });
  }
}

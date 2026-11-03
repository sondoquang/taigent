---
name: taiga-apply-backlog
description: "Show the Taiga plan of a backlog manifest, then apply it after you confirm. Carries the BA's edits of taiga/<slug>/preview.md into the manifest first, when that file exists."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent preview *) Bash(npx taigent plan *) Bash(npx taigent apply *) Bash(npx taigent pull *) PowerShell(npx taigent validate *) PowerShell(npx taigent preview *) PowerShell(npx taigent plan *) PowerShell(npx taigent apply *) PowerShell(npx taigent pull *)
---

# Taiga apply backlog

Push `taiga/<slug>/backlog.yaml` to Taiga in four moves: **plan**, show it, **confirm**, **apply**. The `taigent` CLI makes every write. It matches items by their `src:<key>` tag (re-running is safe), never deletes anything, and leaves status, assignee, sprint and points to the people doing the work.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding `docs/cli.md`, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Pick the project

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask. No `taiga/<slug>/backlog.yaml` yet: there is nothing to apply; suggest `taiga-plan-backlog` and stop.

## 2. Carry the preview edits into the manifest

Skip this step when `taiga/<slug>/preview.md` does not exist.

`preview.md` is the output of `npx taigent preview` that the BA may have edited. `taiga/<slug>/.preview/base.md` is the untouched copy written at the same moment. The manifest stays the source of truth: the BA's edits reach Taiga only by being written into `backlog.yaml` here. Never edit `state.json` (only `apply` writes it) or `project.yaml` (project changes go through `taiga-bootstrap-project`).

1. No `.preview/base.md`: the BA's edits cannot be told apart from the rest. Say so and ask whether to apply the manifest without them or stop; on stop, end the skill with nothing changed.
2. Run `npx taigent preview --project <slug> --out taiga/<slug>/.preview/now.md`, then `git diff --no-index --ignore-cr-at-eol -- taiga/<slug>/.preview/base.md taiga/<slug>/.preview/now.md`. Exit 1: the manifest changed after the preview was written (for example `taiga-plan-backlog` answered review comments). Show that diff and ask whether to carry the BA's edits onto the current manifest anyway or stop; on stop, end the skill with nothing changed.
3. Run `git diff --no-index --ignore-cr-at-eol -- taiga/<slug>/.preview/base.md taiga/<slug>/preview.md`. Exit 0: the BA changed nothing; go on to the plan (step 3 of this skill). Exit 1: every hunk is an edit of the BA.
4. Write each edit into `backlog.yaml` with targeted edits that keep keys, comments and order (conventions §4–§6 still hold). The preview renders each item as below; map the edited line back to its field:

   | In `preview.md` | Field in `backlog.yaml` |
   |---|---|
   | `## Epic KEY: …`, `### Story KEY: …`, `#### Task KEY: …`, `### Issue KEY: …` | that item's `subject` (the text after `KEY: `) |
   | `` tags: `a`, `b` `` in the line under the heading | `tags` |
   | `type: …`, `severity: …`, `priority: …` in that line | an issue's `type`, `severity`, `priority` |
   | `custom attributes: name = value` in that line | `custom_attributes` |
   | `- **As a** …`, `- **I want to** …`, `- **so that** …` | `use_case.as_a`, `use_case.i_want_to`, `use_case.so_that` |
   | `- [ ] **Scenario:** …` and the lines under it: `**Given:**` and each `**and Given:**`, `**When:**`, `**Then:**` | that scenario's `scenario`, `given` (in order), `when`, `then` |
   | A story's text between the use case and `Acceptance criteria` | `description` |
   | A legacy story's `- [ ] …` lines under `Acceptance criteria` | `acceptance_criteria` |
   | `Spec: …` | `spec` |
   | An epic's, task's or issue's text under the `**Review:**` line | `description`; its headings are nested one level per heading level of the item, so lift them back |

   - A new block whose key is not in the manifest: a new item at that place, shaped per conventions §5–§6 (a new story always in the user story format).
   - A deleted block or a changed key: do not remove the item. List it and ask: removing an item already on Taiga makes it an orphan, never deleted there.
   - Edits to the summary table, `on Taiga #n` / `new (not on Taiga yet)`, the `**Review:**` line or the comments are not manifest fields: leave them out and name them in your report. Reviews live in `review.yaml`.
   - The BA asks in prose for a change instead of making it: make it only when it is unambiguous; otherwise ask.
5. Run `npx taigent validate --project <slug>`; fix every problem and run it again until exit 0.
6. Check that nothing was lost: run `npx taigent preview --project <slug> --out taiga/<slug>/.preview/now.md`, then `git diff --no-index --ignore-cr-at-eol -- taiga/<slug>/.preview/now.md taiga/<slug>/preview.md`. The only hunks left must be the edits you left out on purpose (and the summary counts of added items); carry over any other one and repeat from 5.
7. Make both copies match the manifest: `npx taigent preview --project <slug> --out taiga/<slug>/preview.md`, then `npx taigent preview --project <slug> --out taiga/<slug>/.preview/base.md`.

Done when the BA's edits are in `backlog.yaml`, validate exits 0 and both copies match it. Keep the list of changed fields per key (`field: from → to`) for step 4.

## 3. Plan

Run `npx taigent plan --project <slug>`.

- **Exit 3**: there are changes. Go to step 4.
- **Exit 0**: Taiga already matches the manifest. Say so and stop.
- **Exit 4**: the manifest breaks a convention. Show the problems, suggest `taiga-plan-backlog` (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`) to fix them, and stop.
- **Exit 6**: some items are blocked (changed on Taiga since taigent last wrote them). Never run `apply --yes` while plan has blocked items. Show the `blocked` list (`npx taigent plan --project <slug> --json`: each item's `kind` and `fields`) and settle every item with the user as `taiga-plan-backlog` step 3 does: `remote-edit` → `npx taigent pull --project <slug> --key <KEY>` (Taiga wins), or `--keep-manifest` when the user deliberately keeps the manifest's values; `conflict` → merge with the user into `backlog.yaml`, then `pull --key <KEY> --keep-manifest`; `unknown` (the first plan after upgrading taigent shows earlier items that differ from Taiga this way; explain it once for the group) → `npx taigent pull --project <slug>`. On pull exit 4 (kind `pull`), rewrite the item from `error.description` in the user story format, pull it with `--keep-manifest`, and send it back to review instead of applying. Then return to step 3.
- **Exit 2 or 5**: show the error (missing variable, login refused, unknown project, Taiga unreachable) and stop. For a missing `TAIGA_*` variable or a refused login, name `taiga-setup` as the fix; for an unknown project, `taiga-bootstrap-project`.

## 4. Show the plan and ask

When step 2 carried edits, first list them per key (`field: from → to`) and the edits left out.

Show the plan output exactly as printed: every `create`, `update` and `link` line, the orphans, the stale links and the summary line. When it has `update` lines, also run `npx taigent plan --project <slug> --json` and show each update's `changes` as `field: from → to` (an issue's `type`, `severity` and `priority` hold ids: show their `names`). Orphans are items on Taiga whose key left the manifest; stale links are stories linked on Taiga to an epic other than their manifest epic. `taigent` keeps both on Taiga as they are, so say that.

Then ask: "Apply these changes to Taiga project `<slug>`?" and end your turn. Go on only when the user explicitly confirms this plan; any other reply ends the skill with Taiga untouched.

## 5. Apply

After the confirmation:

1. Run `npx taigent plan --project <slug>` again. When its operations differ from the plan the user confirmed (the manifest or Taiga changed meanwhile), show the new plan and return to step 4.
2. Run `npx taigent apply --project <slug> --yes`.

Done when apply exits 0.

- **Exit 6, blocked**: an item was changed on Taiga after the plan; nothing was written. Settle it as in step 3 and return to step 3.
- **Exit 5, conflict**: an item changed on Taiga during apply; nothing was overwritten. Show the message and return to step 3.
- **Other exit 5**: show the message. Apply resumes where it stopped, so the user can re-run this skill once the cause is fixed.

## 6. Report

Report apply's summary line (created, updated, linked, unchanged) and remind the user to commit `taiga/<slug>/state.json` together with the manifest. When `preview.md` exists, refresh both copies as in step 2.7 (the items now show their Taiga refs), and remind the user that `preview.md` and `.preview/` are working copies, not to be committed.

This skill reaches Taiga only through `npx taigent`, and writes only through `npx taigent apply --yes` after the user's confirmation (`docs/taiga/conventions.md` §10).

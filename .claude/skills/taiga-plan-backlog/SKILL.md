---
name: taiga-plan-backlog
description: "Taiga backlog planning into the backlog manifest (epics, stories, tasks, issues), files only. Use when turning a spec or PRD into a Taiga backlog, adding or changing epics, stories, tasks or issues (bugs, questions, enhancements) of an existing manifest, or answering the BA/PO review comments in review.yaml."
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent plan *) Bash(npx taigent preview *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) PowerShell(npx taigent preview *) mcp__taiga__listProjects mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory mcp__taiga__listIssues mcp__taiga__getIssue
---

# Taiga plan backlog

Turn a spec into the **backlog manifest** `taiga/<slug>/backlog.yaml`, and answer the review comments of the Business Analyst / Product Owner in `taiga/<slug>/review.yaml`. This skill writes repository files only. Taiga changes later, through `taiga-apply-backlog` (Claude Code `/taiga-apply-backlog`, Codex `$taiga-apply-backlog`), after a human has reviewed the manifest.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root** is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Taiga MCP tool names below are those of the `taiga` server; your agent prefixes them (Claude Code: `mcp__taiga__listEpics`). Without them, run `taiga-setup` too.

## Reference

In the taigent root:

- `docs/taiga/conventions.md`: plan → review → apply (§1), tags (§4), keys (§5), epic/story/task/issue templates (§6; issues §6.4), banned MCP tools (§10). Read §1 and §4–§6 before editing.
- `docs/cli.md`, section "Manifest layout": the `backlog.yaml` schema. Fields it does not list are rejected. Section "Commands": the `plan --json` output. Section "Review": the `review.yaml` format and `taigent preview`.

Run each `npx taigent …` command exactly as written, alone in its own shell call from the project root, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Gather the inputs

- **Spec**: the path, URL or text the user gave; a one-line request such as "add a password-reset story under AUTH" or a bug report ("login fails with a long password") is a spec too. Read all of it. A request to answer the review ("xử lý comment review") needs no other spec: the open comments of `review.yaml` are the spec.
- **Slug**: the project the user named. With exactly one directory under `taiga/`, use it; otherwise ask. A slug without a `taiga/<slug>/` directory: check with `listProjects` that the project exists on Taiga; when it does not, plan anyway, skip the Taiga reads of step 2, and name `taiga-bootstrap-project` as the step before apply in your report.

Done when you have read the spec and know the slug.

## 2. Read what exists

1. `taiga/<slug>/backlog.yaml`, when present, is the **baseline**. Without a baseline, every item on Taiga was made by hand: go to 3.
2. With a baseline, run `npx taigent plan --project <slug> --json`. It only reads Taiga.
   - **Exit 0 or 3**: operations with action `skip` or `update` are manifest items already on Taiga, with their `id` and `ref`; `orphans` are `src:`-tagged items whose key has left the manifest.
   - **Exit 4**: the baseline breaks a convention. Fix every problem listed (`--json`: `error.issues`, each with `path` and `rule`; `npx taigent validate --project <slug>` lists the offline ones), and run plan again. Rule `issue-value` names an issue `type`, `severity` or `priority` the project does not define; its message lists the names that exist.
   - **Exit 2 or 5**: Taiga cannot be read. `taiga/<slug>/state.json` lists the keys last applied; carry on from it and the baseline, skip 3, and name this gap in your report, with `taiga-setup` as the fix when the message names a missing `TAIGA_*` variable or a refused login.
3. Hand-made work carries no `src:` tag, so the plan never lists it. List the project's epics with `listEpics` (`project`: the numeric id, `project.id` in the plan), its stories with `listUserStories` (`projectIdentifier: "<slug>"`; it returns at most the first 30 stories) and, when the spec reports bugs or questions, its issues with `listIssues` (`projectIdentifier: "<slug>"`). An epic id, story or issue `#ref` found in neither the plan's operations nor its orphans was made by hand; read it with `getEpic`, `getUserStory` or `getIssue` when its subject overlaps the spec, and ask the user before adding a manifest item for the same work.

Done when every epic, story and issue read from Taiga is known as a manifest item, an orphan or hand-made work, or Taiga could not be read and your report will say so.

## 3. Edit the manifest

Patch the baseline in place with targeted edits, leaving every other line untouched, so the git diff shows only what the spec changes:

- Keep every existing item with its `key` (conventions §5), position and comments.
- Change an existing item's `subject`, `description`, `acceptance_criteria`, `use_case`, `scenarios`, `spec`, `tags`, or an issue's `type`, `severity` or `priority`, where the spec changes it.
- Add new work as new items under the epic or story it belongs to, with new keys. A bug, question or small enhancement the spec reports is an **issue**: a new entry of the top-level `issues` list, not a story.
- Keep items the spec no longer covers, and list them in your report: the user decides whether to remove them (a removed item becomes an orphan on Taiga, never deleted).
- No baseline yet: create `taiga/<slug>/backlog.yaml` following the schema in `docs/cli.md`.

Shape every epic, story, task and issue per conventions §4–§6, and write subjects and descriptions in the spec's language. Story format (conventions §6):

- Every **new** story uses the user story format (§6.1): `subject` is the Summary, plus `use_case` and `scenarios` (one or more Given, exactly one When, exactly one Then per scenario). `plan` exits 4 with rule `story-format` for a new story in the legacy format. Run the §6.1 quality check, and split a story that needs several When/Then or carries several goals.
- An **existing** story keeps its current format (the legacy format, `description` + `acceptance_criteria`, §6.2) when you edit it, unless the user asks to convert it; a conversion rewrites its Taiga description, so name it in your report.

Issues (conventions §6.4): `subject` states the symptom; `description` follows the "Steps to reproduce / Expected / Actual" template for a bug; `type`, `severity` and `priority` are the exact names of the project's values (§6.4 says how to choose them; the default templates have `Bug`/`Question`/`Enhancement`, `Wishlist`…`Critical`, `Low`/`Normal`/`High`). Never write a status, assignee or sprint: people set them on Taiga. When the spec does not say how severe or urgent a bug is, pick per §6.4 and name your choice in the report.

Done when every requirement of the spec maps to a story or task, every reported bug or question to an issue, or is named as out of scope in your report.

## 4. Answer the review

`taiga/<slug>/review.yaml` holds, per item key, the reviewer's `verdict` (`approved` or `changes`) and their `comments`; Taigent Desktop or the reviewer writes it. Skip this step when the file is absent. `npx taigent preview --project <slug>` (offline) shows every item with its review status and open comments.

For each comment whose `resolved` is `false` or missing:

1. Address it by editing `backlog.yaml` with the rules of step 3: the comment's item key names what to change.
2. Set `resolved: true` and `reply:` a short answer in Vietnamese saying what changed, e.g. `reply: Đã thêm tiêu chí khoá tài khoản sau 5 lần sai.` Edit only these two fields of that comment.
3. A comment that needs a decision you cannot take from the spec, or that you disagree with: leave the manifest and `resolved: false`, set `reply` to your question or reason, and list it in your report.

The verdicts and the comments' `id`, `by`, `at` and `text` belong to the reviewer: never change, add or remove them. An item edited after its `approved` verdict becomes **stale** (its digest changed) and goes back to the reviewer. When the user has you remove an item that `review.yaml` lists, delete its entry there too; validate reports `key-reference` otherwise.

Done when every open comment is resolved or carries your question.

## 5. Validate

Run `npx taigent validate --project <slug>`; it checks `review.yaml` too. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 6. Report

Tell the user:

- keys added, and keys changed with the fields that changed; for new issues, the `type`, `severity` and `priority` you chose;
- items the spec no longer covers;
- hand-made Taiga work that overlaps the spec, and any part of Taiga that could not be read;
- review comments answered (key, comment id, reply), comments left open with your question, and approved items you changed (now stale);
- next step: the reviewer checks the backlog in Taigent Desktop or with `npx taigent preview --project <slug>` (and `git diff taiga/<slug>/`), then run `taiga-apply-backlog` (`/taiga-apply-backlog`, Codex `$taiga-apply-backlog`). An `approved` verdict is not the user's consent to apply.

Taiga stays read-only in this skill: read it only through `npx taigent plan` and the MCP read tools of `allowed-tools` (conventions §10).

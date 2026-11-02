---
name: taiga-plan-backlog
description: "Taiga backlog planning into the backlog manifest (epics, stories, tasks), files only. Use when turning a spec or PRD into a Taiga backlog, or adding or changing epics, stories or tasks of an existing manifest."
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent plan *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) mcp__taiga__listProjects mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory
---

# Taiga plan backlog

Turn a spec into the **backlog manifest** `taiga/<slug>/backlog.yaml`. This skill writes repository files only. Taiga changes later, through `taiga-apply-backlog` (Claude Code `/taiga-apply-backlog`, Codex `$taiga-apply-backlog`), after a human has reviewed the manifest diff.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root** is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Taiga MCP tool names below are those of the `taiga` server; your agent prefixes them (Claude Code: `mcp__taiga__listEpics`). Without them, run `taiga-setup` too.

## Reference

In the taigent root:

- `docs/taiga/conventions.md`: plan → review → apply (§1), tags (§4), keys (§5), epic/story/task templates (§6), banned MCP tools (§10). Read §1 and §4–§6 before editing.
- `docs/cli.md`, section "Manifest layout": the `backlog.yaml` schema. Fields it does not list are rejected. Section "Commands": the `plan --json` output.

Run each `npx taigent …` command exactly as written, alone in its own shell call from the project root, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Gather the inputs

- **Spec**: the path, URL or text the user gave; a one-line request such as "add a password-reset story under AUTH" is a spec too. Read all of it.
- **Slug**: the project the user named. With exactly one directory under `taiga/`, use it; otherwise ask. A slug without a `taiga/<slug>/` directory: check with `listProjects` that the project exists on Taiga; when it does not, plan anyway, skip the Taiga reads of step 2, and name `taiga-bootstrap-project` as the step before apply in your report.

Done when you have read the spec and know the slug.

## 2. Read what exists

1. `taiga/<slug>/backlog.yaml`, when present, is the **baseline**. Without a baseline, every item on Taiga was made by hand: go to 3.
2. With a baseline, run `npx taigent plan --project <slug> --json`. It only reads Taiga.
   - **Exit 0 or 3**: operations with action `skip` or `update` are manifest items already on Taiga, with their `id` and `ref`; `orphans` are `src:`-tagged items whose key has left the manifest.
   - **Exit 4**: the baseline breaks a convention. Run `npx taigent validate --project <slug>`, fix every problem it lists, and run plan again.
   - **Exit 2 or 5**: Taiga cannot be read. `taiga/<slug>/state.json` lists the keys last applied; carry on from it and the baseline, skip 3, and name this gap in your report, with `taiga-setup` as the fix when the message names a missing `TAIGA_*` variable or a refused login.
3. Hand-made work carries no `src:` tag, so the plan never lists it. List the project's epics with `listEpics` (`project`: the numeric id, `project.id` in the plan) and its stories with `listUserStories` (`projectIdentifier: "<slug>"`; it returns at most the first 30 stories). An epic id or story `#ref` found in neither the plan's operations nor its orphans was made by hand; read it with `getEpic` or `getUserStory` when its subject overlaps the spec, and ask the user before adding a manifest item for the same work.

Done when every epic and story read from Taiga is known as a manifest item, an orphan or hand-made work, or Taiga could not be read and your report will say so.

## 3. Edit the manifest

Patch the baseline in place with targeted edits, leaving every other line untouched, so the git diff shows only what the spec changes:

- Keep every existing item with its `key` (conventions §5), position and comments.
- Change an existing item's `subject`, `description`, `acceptance_criteria`, `use_case`, `scenarios`, `spec` or `tags` where the spec changes it.
- Add new work as new items under the epic or story it belongs to, with new keys.
- Keep items the spec no longer covers, and list them in your report: the user decides whether to remove them (a removed item becomes an orphan on Taiga, never deleted).
- No baseline yet: create `taiga/<slug>/backlog.yaml` following the schema in `docs/cli.md`.

Shape every epic, story and task per conventions §4–§6, and write subjects and descriptions in the spec's language. Story format (conventions §6):

- Every **new** story uses the §6.1 format: `subject` is the Summary, plus `use_case` and `scenarios` (one or more Given, exactly one When, exactly one Then per scenario). `plan` exits 4 with rule `story-format` for a new story in the old format. Run the §6.1 quality check, and split a story that needs several When/Then or carries several goals.
- An **existing** story keeps its current format (old `description` + `acceptance_criteria`, §6.2) when you edit it, unless the user asks to convert it; a conversion rewrites its Taiga description, so name it in your report.

Done when every requirement of the spec maps to a story or task, or is named as out of scope in your report.

## 4. Validate

Run `npx taigent validate --project <slug>`. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 5. Report

Tell the user:

- keys added, and keys changed with the fields that changed;
- items the spec no longer covers;
- hand-made Taiga work that overlaps the spec, and any part of Taiga that could not be read;
- next step: review `git diff taiga/<slug>/`, then run `taiga-apply-backlog` (`/taiga-apply-backlog`, Codex `$taiga-apply-backlog`).

Taiga stays read-only in this skill: read it only through `npx taigent plan` and the MCP read tools of `allowed-tools` (conventions §10).

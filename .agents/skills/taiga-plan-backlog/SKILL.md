---
name: taiga-plan-backlog
description: Plan a Taiga backlog from a spec or PRD into taiga/[slug]/backlog.yaml (epics, stories, tasks), updating the existing manifest in place per the Taiga conventions. Use when the user asks to plan, draft or update Taiga epics, stories or tasks. Writes files only; taiga-apply-backlog pushes them.
allowed-tools: Bash(npx taigent validate *) PowerShell(npx taigent validate *) mcp__taiga__listProjects mcp__taiga__getProject mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory mcp__taiga__advancedSearch mcp__taiga__queryHelp mcp__taiga__validateQuery
---

# Taiga plan backlog

Turn a spec into the **backlog manifest** `taiga/<slug>/backlog.yaml`. This skill writes repository files only. Taiga changes later, through `/taiga-apply-backlog` (Codex: `$taiga-apply-backlog`), after a human has reviewed the manifest diff.

## Reference

- `docs/taiga/conventions.md`: plan → review → apply (§1), tags (§4), keys (§5), epic/story/task templates (§6), banned MCP tools (§10). Read §1 and §4–§6 before editing.
- `docs/cli.md`, section "Manifest layout": the `backlog.yaml` schema. Fields it does not list are rejected.
- Run each CLI command on its own from the repository root, exactly as written (`npx taigent …`, no `cd`, `&&`, `;` or `echo`): the shell tool reports its exit code.

## 1. Gather the inputs

- **Spec**: the path, URL or text the user gave. Read all of it.
- **Slug**: the project the user named. With exactly one directory under `taiga/`, use it; otherwise ask.

Done when you have read the spec and know the slug.

## 2. Read what exists

- `taiga/<slug>/backlog.yaml`, when present, is the **baseline**. Keys listed in `taiga/<slug>/state.json` are already on Taiga.
- Optionally check Taiga for work that already exists, with the read-only Taiga MCP tools in this skill's `allowed-tools` (`listEpics`, `listUserStories`, `getUserStory`, `advancedSearch`). Items without a `src:` tag were created by hand: ask the user before adding a manifest item for the same work.

## 3. Edit the manifest

Patch the baseline in place with targeted edits, leaving every other line untouched, so the git diff shows only what the spec changes:

- Keep every existing item with its `key`, position and comments. The key is the item's identity on Taiga: a renamed key creates a second item and orphans the first.
- Change an existing item's `subject`, `description`, `acceptance_criteria`, `spec` or `tags` where the spec changes it.
- Add new work as new items under the epic or story it belongs to, with new keys.
- Keep items the spec no longer covers, and list them in your report: the user decides whether to remove them (a removed item becomes an orphan on Taiga, never deleted).
- No baseline yet: create `taiga/<slug>/backlog.yaml` following the schema in `docs/cli.md`.

Shape every item per the conventions:

- **Epic**: one feature area, key like `AUTH`; `description` states the goal and links the spec.
- **Story**: one user-visible capability, key `<EPIC>-<WORK>` like `AUTH-LOGIN`; `description` is the user-story sentence; each `acceptance_criteria` entry is one checkable sentence; `spec` is the spec's path or link.
- **Task**: one step of its story, key `<STORY>-<STEP>` like `AUTH-LOGIN-API`; `description` states when the task is done.
- **Tags**: lowercase `type:feature|bug|chore` and `area:<kebab-case>`. `taigent` adds the `src:` tag itself.
- Write subjects and descriptions in the spec's language.

Done when every requirement of the spec maps to a story or task, or is named as out of scope in your report.

## 4. Validate

Run `npx taigent validate --project <slug>`. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 5. Report

Tell the user:

- keys added, and keys changed with the fields that changed;
- items the spec no longer covers;
- next step: review `git diff taiga/<slug>/`, then run `/taiga-apply-backlog` (Codex: `$taiga-apply-backlog`).

Taiga stays read-only in this skill: use only the MCP read tools above, never an MCP create, update, link, batch or delete tool (conventions §10).

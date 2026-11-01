---
name: taiga-apply-backlog
description: "Apply a Taiga backlog: show `taigent plan` for taiga/[slug]/backlog.yaml, then run `taigent apply --yes` only after the user confirms. Run by hand after reviewing the manifest diff."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent plan *) Bash(npx taigent apply *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) PowerShell(npx taigent apply *) mcp__taiga__listProjects mcp__taiga__getProject mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory mcp__taiga__advancedSearch mcp__taiga__queryHelp mcp__taiga__validateQuery
---

# Taiga apply backlog

Push `taiga/<slug>/backlog.yaml` to Taiga in four moves: **plan**, show it, **confirm**, **apply**. The `taigent` CLI makes every write. It matches items by their `src:<key>` tag (re-running is safe), never deletes anything, and leaves status, assignee, sprint and points to the people doing the work.

Run each command on its own from the repository root, exactly as written (`npx taigent …`, no `cd`, `&&`, `;` or `echo`): the shell tool reports its exit code. Exit codes (`docs/cli.md`): 0 success with nothing left to change, 2 usage error or missing `TAIGA_*` variable, 3 the plan has changes, 4 manifest invalid, 5 Taiga/network error or conflict.

## 1. Pick the project

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask.

## 2. Plan

Run `npx taigent plan --project <slug>`.

- **Exit 3**: there are changes. Go to step 3.
- **Exit 0**: Taiga already matches the manifest. Say so and stop.
- **Exit 4**: the manifest breaks a convention. Show the problems, suggest `/taiga-plan-backlog` (Codex: `$taiga-plan-backlog`) to fix them, and stop.
- **Exit 2 or 5**: show the error (missing variable, login refused, unknown project, Taiga unreachable) and stop.

## 3. Show the plan and ask

Show the plan output exactly as printed: every `create`, `update` and `link` line, the orphans, and the summary line. When it has `update` lines, also run `npx taigent plan --project <slug> --json` and show each update's `changes` as `field: from → to`. Orphans are items on Taiga whose key left the manifest; `taigent` keeps them on Taiga, so say that.

Then ask: "Apply these changes to Taiga project `<slug>`?" and end your turn. Go on only when the user explicitly confirms this plan; any other reply ends the skill with Taiga untouched.

## 4. Apply

After the confirmation:

1. Run `npx taigent plan --project <slug>` again. When its operations differ from the plan the user confirmed (the manifest or Taiga changed meanwhile), show the new plan and return to step 3.
2. Run `npx taigent apply --project <slug> --yes`.

Done when apply exits 0.

- **Exit 5, conflict**: an item changed on Taiga during apply; nothing was overwritten. Show the message and return to step 2.
- **Other exit 5**: show the message. Apply resumes where it stopped, so the user can re-run this skill once the cause is fixed.

## 5. Report

Report apply's summary line (created, updated, linked, unchanged) and remind the user to commit `taiga/<slug>/state.json` together with the manifest.

Taiga writes in this skill go only through `npx taigent apply --yes` after the user's confirmation. The Taiga MCP tools serve reading only (the ones in `allowed-tools`), never creating, updating, linking or deleting (`docs/taiga/conventions.md` §10).

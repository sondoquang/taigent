---
name: prd-to-taiga
description: "Turns a PRD (GitHub issue, file or pasted text) into the Taiga backlog manifest through taiga-plan-backlog, summarises the stories with the PRD user story each one comes from, and on request writes taiga/<slug>/preview.md for the BA to read and edit before taiga-apply-backlog. Files only: never applies to Taiga."
disable-model-invocation: true
argument-hint: "<PRD: #issue | path | text> [slug]"
allowed-tools: Skill(taiga-plan-backlog) Bash(gh issue view *) Bash(npx taigent validate *) Bash(npx taigent plan *) Bash(npx taigent preview *) Bash(npx taigent snapshot *) Bash(npx taigent adopt *) Bash(npx taigent pull *) PowerShell(gh issue view *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) PowerShell(npx taigent preview *) PowerShell(npx taigent snapshot *) PowerShell(npx taigent adopt *) PowerShell(npx taigent pull *) mcp__taiga__listProjects
---

# PRD to Taiga

The user gives the PRD (a GitHub issue `#<n>` or its URL, a path to a file, or the text itself) and, optionally,
the project slug (none: let taiga-plan-backlog pick it).

This skill writes repository files only. It never runs `npx taigent apply`
and never calls an MCP tool that writes.

## 1. Read the PRD

- `#<n>` or a GitHub issue URL: run `gh issue view <n> --json number,title,body,comments`,
  alone in its own shell call. Exit code other than 0 (no `gh`, not logged in, unknown issue): show the error
  and stop.
- A path to an existing file: read the whole file.
- Anything else: the user's text itself is the PRD.

Number the PRD's user stories US1, US2, … in the order they appear.
Done when you hold the whole PRD and its numbered user stories.

## 2. Plan the backlog

Use the `taiga-plan-backlog` skill with this PRD as its spec and the slug the user gave as its slug.
Follow every step of it; do not restate its rules here. On top of it:

- set each new story's `spec:` to a link the developers can open: the issue URL, or a path in the
  repository; never a path that exists only on this machine;
- put a comment `# USn` (or `# US2, US3`) on the line above each story built
  from those user stories.

Done when taiga-plan-backlog has finished with
`npx taigent validate --project <slug>` exit 0.

## 3. Summary

Instead of a long report, give the user:

- one line: project slug, counts of epics / stories / tasks / issues, and whether the project exists on Taiga
  yet (when it does not, `taiga-bootstrap-project` comes before apply). Count from the manifest keys; the
  story rows and the Tasks column of the table below must add up to the same numbers;
- one table, one row per story, in manifest order:

  | Key | Story (subject) | Epic | Tasks | PRD |
  |-----|-----------------|------|-------|-----|
  | `PWRESET-EMAIL` | … | `PWRESET` | 3 | US1 |

- one row per issue the same way (Tasks: –), and below the table every PRD user story that no story covers,
  with the reason (out of scope, merged into another story…). Every USn appears in the table or below it.

## 4. Ask about the preview

Ask (in Claude Code, with the AskUserQuestion tool): "Xem preview từng ticket trước khi apply?", with two options:
"Có, tạo preview.md" and "Không, apply luôn".

- **Có**: run these two commands, each alone in its own shell call:
  `npx taigent preview --project <slug> --out taiga/<slug>/preview.md`, then
  `npx taigent preview --project <slug> --out taiga/<slug>/.preview/base.md`.
  Tell the user: open `taiga/<slug>/preview.md`, one section per epic, story, task and issue; edit subjects,
  use case, scenarios (Given / When / Then), descriptions and tags in place, add or remove blocks; never touch
  `.preview/base.md`. Then run `taiga-apply-backlog` (`/taiga-apply-backlog <slug>`, Codex
  `$taiga-apply-backlog`): it writes those edits into `backlog.yaml`, validates, shows the plan and applies only
  after an explicit yes. Neither file is to be committed.
- **Không**: the next step is `taiga-apply-backlog` (`/taiga-apply-backlog <slug>`, Codex `$taiga-apply-backlog`),
  after `taiga-bootstrap-project` when the project does not exist yet.

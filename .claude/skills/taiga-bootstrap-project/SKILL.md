---
name: taiga-bootstrap-project
description: "Bootstrap a Taiga project: write or check taiga/[slug]/project.yaml, show `taigent bootstrap --dry-run`, then run `taigent bootstrap --yes` only after the user confirms. Creates the project or fills gaps (modules, tags, custom attributes, members, wiki home)."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent bootstrap *) PowerShell(npx taigent validate *) PowerShell(npx taigent bootstrap *) mcp__taiga__listProjects mcp__taiga__getProject
---

# Taiga bootstrap project

Create a Taiga project, or complete an existing one, from `taiga/<slug>/project.yaml` in four moves: **manifest**, **dry run**, **confirm**, **bootstrap**. The `taigent` CLI makes every write. It never creates templates, and never disables, renames or deletes anything: a re-run only fills gaps.

Run each command on its own from the repository root, exactly as written (`npx taigent …`, no `cd`, `&&`, `;` or `echo`): the shell tool reports its exit code. Exit codes (`docs/cli.md`): 0 success with nothing left to change, 2 usage error or missing `TAIGA_*` variable, 3 the dry run has changes, 4 manifest invalid, 5 Taiga/network error or refusal.

## 1. Write or check the manifest

Read `docs/cli.md` section "Bootstrap" (the `project.yaml` schema; fields it does not list are rejected) and `docs/taiga/conventions.md` §2–§4 (name, slug, template, modules, tags).

- **`taiga/<slug>/project.yaml` exists**: read it and check it against what the user asked for. Edit only the lines that must change.
- **No manifest yet**: gather from the user what you cannot derive: the name `<Client/Area> - <Product>`, a one-line description, `scrum` (product work in sprints) or `kanban` (operations, support, DevOps), members and their roles. Derive the slug from the name (conventions §2), then write `taiga/<slug>/project.yaml` with `modules` including `epics` and `wiki`.
- To see whether the project already exists, use `mcp__taiga__listProjects` (and `mcp__taiga__getProject` for details). An existing slug is completed, not duplicated; bootstrap needs the user to be its admin.

Then run `npx taigent validate --project <slug>`. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 2. Dry run

Run `npx taigent bootstrap --project <slug> --dry-run`.

- **Exit 3**: there are changes. Go to step 3.
- **Exit 0**: Taiga already matches the manifest. Say so and stop.
- **Exit 4**: fix the manifest (step 1).
- **Exit 2 or 5**: show the error (missing variable, login refused, not an admin, unknown role or template, Taiga unreachable) and stop.

## 3. Show the dry run and ask

Show the output exactly as printed: every `create` and `update` line and the summary line. When the project itself is created, point out its name, template and privacy.

Then ask: "Bootstrap Taiga project `<slug>` with these changes?" and end your turn. Go on only when the user explicitly confirms this dry run; any other reply ends the skill with Taiga untouched.

## 4. Bootstrap

After the confirmation:

1. Run `npx taigent bootstrap --project <slug> --dry-run` again. When its operations differ from the ones the user confirmed (the manifest or Taiga changed meanwhile), show the new ones and return to step 3.
2. Run `npx taigent bootstrap --project <slug> --yes`.

Done when it exits 0.

- **Exit 5, slug mismatch**: Taiga derived another slug than the manifest's (e.g. with a username prefix). The project exists and `state.json` records its real slug: show the message and let the user decide (rename the manifest directory and `slug`, or fix the project on Taiga). Never run bootstrap again to "retry" the creation.
- **Other exit 5**: show the message. A re-run fills the remaining gaps once the cause is fixed.

## 5. Report

Report the summary line (created, updated, unchanged) and remind the user to commit `taiga/<slug>/project.yaml` and `taiga/<slug>/state.json`. Next steps: `/taiga-plan-backlog` (Codex: `$taiga-plan-backlog`) to plan the backlog, `/taiga-upload-docs` (Codex: `$taiga-upload-docs`) for wiki pages and files.

Taiga writes in this skill go only through `npx taigent bootstrap --yes` after the user's confirmation. The Taiga MCP tools serve reading only (the ones in `allowed-tools`), never creating, updating or deleting (`docs/taiga/conventions.md` §10).

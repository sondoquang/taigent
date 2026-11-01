---
name: taiga-bootstrap-project
description: "Create or complete a Taiga project from its project.yaml, after a dry run you confirm."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent bootstrap *) PowerShell(npx taigent validate *) PowerShell(npx taigent bootstrap *) mcp__taiga__listProjects mcp__taiga__getProject
---

# Taiga bootstrap project

Create a Taiga project, or complete an existing one, from `taiga/<slug>/project.yaml` in four moves: **manifest**, **dry run**, **confirm**, **bootstrap**. The `taigent` CLI makes every write. It never creates templates, and never disables, renames or deletes anything: a re-run only fills gaps.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/` (created by this skill when absent). Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding the docs cited below, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Taiga MCP tool names below are those of the `taiga` server; your agent prefixes them (Claude Code: `mcp__taiga__listProjects`).

Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Write or check the manifest

Read `docs/cli.md` section "Bootstrap" (the `project.yaml` schema; fields it does not list are rejected) and `docs/taiga/conventions.md` §2–§4 (name, slug, template, modules, tags).

- **`taiga/<slug>/project.yaml` exists**: read it and check it against what the user asked for. Edit only the lines that must change.
- **No manifest yet**: gather from the user what you cannot derive (the name, a one-line description, the template, members and their roles), then write `taiga/<slug>/project.yaml` per those conventions.
- To see whether the project already exists, use `listProjects` (and `getProject` for details); without these tools, rely on the dry run of step 2. An existing slug is completed, not duplicated; bootstrap needs the user to be its admin.

Then run `npx taigent validate --project <slug>`. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 2. Dry run

Run `npx taigent bootstrap --project <slug> --dry-run`.

- **Exit 3**: there are changes. Go to step 3.
- **Exit 0**: Taiga already matches the manifest. Say so and stop.
- **Exit 4**: fix the manifest (step 1).
- **Exit 2 or 5**: show the error (missing variable, login refused, not an admin, unknown role or template, Taiga unreachable) and stop. For a missing `TAIGA_*` variable or a refused login, name `taiga-setup` as the fix.

## 3. Show the dry run and ask

Show the output exactly as printed: every `create` and `update` line and the summary line. When the project itself is created, point out its name, template and privacy.

Then ask: "Bootstrap Taiga project `<slug>` with these changes?" and end your turn. Go on only when the user explicitly confirms this dry run; any other reply ends the skill with Taiga untouched.

## 4. Bootstrap

After the confirmation:

1. Run `npx taigent bootstrap --project <slug> --dry-run` again. When its operations differ from the ones the user confirmed (the manifest or Taiga changed meanwhile), show the new ones and return to step 3.
2. Run `npx taigent bootstrap --project <slug> --yes`.

Done when it exits 0.

- **Exit 5, slug mismatch**: Taiga derived another slug than the manifest's (e.g. with a username prefix). The project exists and `state.json` records its real slug: show the message and let the user decide (rename the manifest directory and `slug`, or fix the project on Taiga). The creation is final: bootstrap runs again only after that decision, never as a retry.
- **Other exit 5**: show the message. A re-run fills the remaining gaps once the cause is fixed.

## 5. Report

Report the summary line (created, updated, unchanged) and remind the user to commit `taiga/<slug>/project.yaml` and `taiga/<slug>/state.json`. Next steps: `taiga-plan-backlog` (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`) to plan the backlog, `taiga-upload-docs` (`/taiga-upload-docs`, Codex `$taiga-upload-docs`) for wiki pages and files.

Taiga writes in this skill go only through `npx taigent bootstrap --yes` after the user's confirmation; the MCP tools of `allowed-tools` serve reading only (`docs/taiga/conventions.md` §10).

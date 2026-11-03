---
name: taiga-apply-backlog
description: "Show the Taiga plan of a backlog manifest, then apply it after you confirm."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent plan *) Bash(npx taigent apply *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) PowerShell(npx taigent apply *)
---

# Taiga apply backlog

Push `taiga/<slug>/backlog.yaml` to Taiga in four moves: **plan**, show it, **confirm**, **apply**. The `taigent` CLI makes every write. It matches items by their `src:<key>` tag (re-running is safe), never deletes anything, and leaves status, assignee, sprint and points to the people doing the work.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding `docs/cli.md`, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Pick the project

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask. No `taiga/<slug>/backlog.yaml` yet: there is nothing to apply; suggest `taiga-plan-backlog` and stop.

## 2. Plan

Run `npx taigent plan --project <slug>`.

- **Exit 3**: there are changes. Go to step 3.
- **Exit 0**: Taiga already matches the manifest. Say so and stop.
- **Exit 4**: the manifest breaks a convention. Show the problems, suggest `taiga-plan-backlog` (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`) to fix them, and stop.
- **Exit 2 or 5**: show the error (missing variable, login refused, unknown project, Taiga unreachable) and stop. For a missing `TAIGA_*` variable or a refused login, name `taiga-setup` as the fix; for an unknown project, `taiga-bootstrap-project`.

## 3. Show the plan and ask

Show the plan output exactly as printed: every `create`, `update` and `link` line, the orphans, the stale links and the summary line. When it has `update` lines, also run `npx taigent plan --project <slug> --json` and show each update's `changes` as `field: from → to` (an issue's `type`, `severity` and `priority` hold ids: show their `names`). Orphans are items on Taiga whose key left the manifest; stale links are stories linked on Taiga to an epic other than their manifest epic. `taigent` keeps both on Taiga as they are, so say that.

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

This skill reaches Taiga only through `npx taigent`, and writes only through `npx taigent apply --yes` after the user's confirmation (`docs/taiga/conventions.md` §10).

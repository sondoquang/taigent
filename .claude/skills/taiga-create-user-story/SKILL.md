---
name: taiga-create-user-story
description: "Write one user story in the Mike Cohn + Gherkin format under an existing epic, then create it on Taiga after you confirm."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent plan *) Bash(npx taigent apply *) PowerShell(npx taigent validate *) PowerShell(npx taigent plan *) PowerShell(npx taigent apply *) mcp__taiga__listProjects mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory
---

# Taiga create user story

Add **one** user story to `taiga/<slug>/backlog.yaml` under an epic that already exists, in the format of `docs/taiga/conventions.md` §6.1, and create it on Taiga after the user confirms. The `taigent` CLI makes the only write. This skill creates no epic and no task, and never writes through MCP.

## 1. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding `docs/`, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes). Exit 2 or 5 naming a missing `TAIGA_*` variable, `not logged in` or a refused login: show it, name `taiga-setup` as the fix, and stop.

## 2. Pick the project and read the standard

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask. No `taiga/<slug>/backlog.yaml` yet: there is no epic to attach to; hand over to `taiga-plan-backlog` (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`) and stop.

Read conventions §5 (keys) and all of §6 (story format, quality check, anti-patterns, splitting rules) in the taigent root.

## 3. Draft the story

From the user's request, draft:

- `subject`: the Summary (§6.1), one short sentence about the value;
- `use_case`: `as_a` (a concrete persona), `i_want_to`, `so_that`;
- `scenarios`: one or more, each with `scenario`, `given` (a list), exactly one `when`, exactly one `then`;
- `description` only when there is context the scenarios do not carry; `spec` when the user named one.

Write in the user's language; keep the labels in English. Ask only for what the request leaves missing (usually the persona or a measurable Then), in one message. Run the §6 quality check and anti-pattern list on the draft. When the request carries several goals or needs several When/Then, propose the split and ask which single story to create now; this skill creates one story per run.

## 4. Check for duplicates

Compare the draft with the stories that already exist:

- the stories in `taiga/<slug>/backlog.yaml`;
- `npx taigent plan --project <slug> --json`: manifest stories already on Taiga (actions `skip`/`update`) and `orphans`;
- hand-made work: `listUserStories` (`projectIdentifier: "<slug>"`, at most the first 30), then `getUserStory` on any whose subject overlaps.

When one looks like the same work, show it with its key or `#ref` and ask whether to create the new story anyway. Go on only on an explicit yes.

## 5. Pick the epic

Propose the existing manifest epic that fits best (`listEpics` and `getEpic` help to read their scope), with one line on why, and ask the user to confirm or choose another manifest epic. When no epic fits, do not create one: hand over to `taiga-plan-backlog` with the draft as the spec, and stop.

## 6. Write it into the manifest

Add the story at the end of the chosen epic's `stories`, with a new key `<EPIC>-<WORK>` (conventions §5) unique across the manifest. Leave every other line untouched. Run `npx taigent validate --project <slug>`; on exit 4 fix every listed problem and run it again. Done when it exits 0.

## 7. Plan

Run `npx taigent plan --project <slug> --json`.

- **Exit 0**: the story is already on Taiga. Say so, with its ref, and stop.
- **Exit 4**: the manifest breaks a convention (for a story, often rule `story-format`). Fix the manifest and run plan again.
- **Exit 3 with operations other than exactly one `create` of this story's key** (other creates, updates or links): list those operations, do not apply, hand over to `taiga-apply-backlog` (`/taiga-apply-backlog`, Codex `$taiga-apply-backlog`) to review the whole plan, and stop.
- **Exit 3 with exactly one `create` of this story's key**: go to step 8.

## 8. Confirm and apply

Show the story as Taiga will render it (§6.1 rendered layout: Use case, then Acceptance criteria) and the plan line, then ask once: "Create this story on Taiga project `<slug>`?" and end your turn. Any reply other than an explicit yes ends the skill; the manifest edit stays for the user to keep or revert.

After the yes:

1. Run `npx taigent plan --project <slug>` again. When its operations are no longer exactly this one create, show the new plan and go back to step 7.
2. Run `npx taigent apply --project <slug> --yes`. Exit 5: show the message and stop; re-running this skill resumes.

Done when apply exits 0. Report the story's ref (from `taiga/<slug>/state.json`, under its key) and its URL, `<Taiga web host>/project/<slug>/us/<ref>`, and remind the user to commit `taiga/<slug>/backlog.yaml` together with `taiga/<slug>/state.json`.

This skill reaches Taiga through `npx taigent` and the MCP read tools of `allowed-tools`, and writes only through `npx taigent apply --yes` after the user's confirmation (`docs/taiga/conventions.md` §10).

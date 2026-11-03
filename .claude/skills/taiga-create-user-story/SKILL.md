---
name: taiga-create-user-story
description: "Write one user story in the user story format (Mike Cohn + Gherkin) under an existing epic, adopting a hand-made epic when it fits best, then create it on Taiga after you confirm."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent snapshot *) Bash(npx taigent adopt *) Bash(npx taigent plan *) Bash(npx taigent apply *) PowerShell(npx taigent validate *) PowerShell(npx taigent snapshot *) PowerShell(npx taigent adopt *) PowerShell(npx taigent plan *) PowerShell(npx taigent apply *)
---

# Taiga create user story

Add **one** user story to `taiga/<slug>/backlog.yaml` under an epic that already exists on Taiga, in the user story format of `docs/taiga/conventions.md` §6.1, and create it on Taiga after the user confirms. When the best epic is a hand-made item (no `src:` tag), the skill adopts it into the manifest (`taigent adopt`) and adds the story under it, in the same plan and apply. The `taigent` CLI makes the only writes. This skill creates no epic and no task, and never writes through MCP.

## 1. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding `docs/`, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes). Exit 2 or 5 naming a missing `TAIGA_*` variable, `not logged in` or a refused login: show it, name `taiga-setup` as the fix, and stop. Exit 6 from `plan` or `apply` (items changed on Taiga since taigent last wrote them, or changed on both sides): list its `blocked` items, write nothing, and stop; they are settled with `taiga-apply-backlog` (`/taiga-apply-backlog`, Codex `$taiga-apply-backlog`) or by pulling Taiga's version (`taigent pull`) before running this skill again.

## 2. Pick the project and read the standard

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask. No `taiga/<slug>/backlog.yaml` yet (a project already on Taiga, never planned with taigent) is no reason to stop or hand over: go on, the epics come from the snapshot (step 4), and adopting a hand-made epic in step 5 creates `backlog.yaml`.

Read conventions §5 (keys) and all of §6 (story format, quality check, anti-patterns, splitting rules) in the taigent root.

## 3. Draft the story

From the user's request, draft:

- `subject`: the Summary (§6.1), one short sentence about the value;
- `use_case`: `as_a` (a concrete persona), `i_want_to`, `so_that`;
- `scenarios`: one or more, each with `scenario`, `given` (a list), exactly one `when`, exactly one `then`;
- `description` only when there is context the scenarios do not carry; `spec` when the user named one.

Write in the user's language; keep the labels in English. Ask only for what the request leaves missing (usually the persona or a measurable Then), in one message. Run the §6 quality check and anti-pattern list on the draft. When the request carries several goals or needs several When/Then, propose the split and ask which single story to create now; this skill creates one story per run.

## 4. Read Taiga and check for duplicates

Run `npx taigent snapshot --project <slug>`. It writes `taiga/<slug>/snapshot.json`: every epic and every open story of the project, hand-made ones too (`key: null`), each with `ref`, `subject`, `tags` and `description`, and each story's `epics` (epic refs). Read that file; never the Taiga MCP lists, which return at most 30 stories.

Compare the draft with the stories that already exist:

- the stories in `taiga/<slug>/backlog.yaml`, when it exists;
- the `stories` of `snapshot.json`, manifest and hand-made alike; read the `description` of any whose subject overlaps.

When one looks like the same work, show it with its key or `#ref` and ask whether to create the new story anyway. Go on only on an explicit yes.

## 5. Pick the epic

Choose among the `epics` of `snapshot.json` that are not `closed`: manifest epics (`key` set) and hand-made epics (`key: null`) alike. Propose the one that fits best, with one line on why, and ask the user to confirm or choose another.

- **A manifest epic**: go to step 6.
- **A hand-made epic**: say that it is not in the manifest yet and that the skill will adopt it (take it into `backlog.yaml` as is, so apply only adds its `src:` tag, and status, assignee and content stay as on Taiga), with the reason it fits, and propose a key (conventions §5, unique across the manifest). After the user confirms epic and key, run `npx taigent adopt --project <slug> --ref <epic ref> --key <KEY>`. Exit 2: show the message (e.g. the key is taken, or `#<ref>` is no hand-made epic), fix the key or the choice with the user, and run it again. A hand-made epic is no reason to hand over to `taiga-plan-backlog`.

When no epic fits, do not create one: hand over to `taiga-plan-backlog` with the draft as the spec, and stop.

## 6. Write it into the manifest

Add the story at the end of the chosen epic's `stories`, with a new key `<EPIC>-<WORK>` (conventions §5) unique across the manifest. Leave every other line untouched. Run `npx taigent validate --project <slug>`; on exit 4 fix every listed problem and run it again. Done when it exits 0.

## 7. Plan

Run `npx taigent plan --project <slug> --json`. Ignore the `skip` operations: they are items already on Taiga and unchanged. The **expected operations** of a new story are: `create` of this story's key (`type: story`, `parent`: the chosen epic) and `link` of this story's key to that epic, plus, when step 5 adopted the epic, exactly one `adopt` of the epic's key (`type: epic`, `ref`: the chosen ref) whose `changes` hold only `tags` adding `src:<key>`. Hand-made stories under the epic, listed in `handMadeChildren`, are not operations; they stay as they are.

- **Exit 0**: the story is already on Taiga. Say so, with its ref, and stop.
- **Exit 6**: items are blocked; see step 1, and stop.
- **Exit 4**: the manifest breaks a convention (for a story, often rule `story-format`). Fix the manifest and run plan again.
- **Exit 3 with any other non-`skip` operation** (another create, an update, another link) **or without one of the expected operations**: list the non-`skip` operations, do not apply, hand over to `taiga-apply-backlog` (`/taiga-apply-backlog`, Codex `$taiga-apply-backlog`) to review the whole plan, and stop.
- **Exit 3 whose non-`skip` operations are exactly the expected operations**: go to step 8.

## 8. Confirm and apply

Show the story as Taiga will render it (§6.1 rendered layout: Use case, then Acceptance criteria), the adopted epic when there is one (`#<ref>` subject → key `<KEY>`, only its `src:` tag is added) and the plan lines, then ask once: "Create this story on Taiga project `<slug>`?" (with an adopted epic: "Adopt epic `#<ref>` and create this story under it on Taiga project `<slug>`?") and end your turn. Any reply other than an explicit yes ends the skill; the manifest edits stay for the user to keep or revert.

After the yes:

1. Run `npx taigent plan --project <slug> --json` again. When its non-`skip` operations are no longer exactly the expected operations, show the new plan and go back to step 7.
2. Run `npx taigent apply --project <slug> --yes`. Exit 6: see step 1. Exit 5: show the message and stop; re-running this skill resumes.

Done when apply exits 0. Report the story's ref (from `taiga/<slug>/state.json`, under its key) and its URL, `<Taiga web host>/project/<slug>/us/<ref>`, and remind the user to commit `taiga/<slug>/backlog.yaml` together with `taiga/<slug>/state.json`.

This skill reaches Taiga only through `npx taigent`: `snapshot`, `adopt` and `plan` read it (`adopt` writes only `backlog.yaml`), and it writes only through `npx taigent apply --yes` after the user's confirmation (`docs/taiga/conventions.md` §10).

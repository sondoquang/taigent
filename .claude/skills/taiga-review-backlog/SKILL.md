---
name: taiga-review-backlog
description: "Review the planned Taiga backlog as the Business Analyst or Product Owner: show it with taigent preview, then record only the verdicts (approve, request changes) and review comments you state for each item into taiga/<slug>/review.yaml. Never decides a verdict itself."
disable-model-invocation: true
allowed-tools: Bash(npx taigent preview *) Bash(npx taigent validate *) Bash(npx taigent review approve *) Bash(npx taigent review request-changes *) Bash(npx taigent review comment *) PowerShell(npx taigent preview *) PowerShell(npx taigent validate *) PowerShell(npx taigent review approve *) PowerShell(npx taigent review request-changes *) PowerShell(npx taigent review comment *)
---

# Taiga review backlog

The reviewer (Business Analyst or Product Owner) checks the backlog that `taiga-plan-backlog` wrote, before it is applied to Taiga. You show it, and you write into `taiga/<slug>/review.yaml` exactly what the reviewer says about each item, through `npx taigent review`. A **verdict** is the reviewer's decision alone (GLOSSARY: Verdict): record one only when the reviewer states it for that item, by its key or an unambiguous name. Never infer one from silence, from "looks fine overall", or from your own judgment, and never approve work you planned.

## 0. Check the setup

Run every command from the **project root**, the directory holding `package.json` and the manifests root `taiga/`. Its `package.json` has `taigent` as `name` (the taigent repository) or as a dependency; otherwise stop and run the `taiga-setup` skill, since `npx taigent` would fetch an unrelated package from the npm registry. The **taigent root**, holding `docs/cli.md`, is the project root when `name` is `taigent`, else `node_modules/taigent/`.

Every command here is offline: no Taiga login is needed. Run each `npx taigent …` command exactly as written, alone in its own shell call, and branch on its exit code (all codes: `docs/cli.md` §Exit codes; the `review` command: §Review).

## 1. Pick the project

The slug the reviewer named. With exactly one directory under `taiga/`, use it; otherwise ask. No `taiga/<slug>/backlog.yaml`: there is nothing to review; suggest `taiga-plan-backlog` and stop.

## 2. Show the backlog

Run `npx taigent preview --project <slug>`. It prints, offline, one Markdown page of what `apply` would write: each epic, story, task and issue with its key, description, current verdict (a **stale** one means the item changed since it was reviewed) and comments. Show the reviewer the items they ask about, or walk through the page in order; state each item's key. Exit 4: a manifest or `review.yaml` is invalid; show the problems and stop: `taiga-plan-backlog` fixes manifests.

Done when the reviewer has seen the items they want to review.

## 3. Record what the reviewer says

For each item the reviewer gives a decision or a remark on, run one command, with that item's key:

- "approve US3", "AUTH-LOGIN is fine": `npx taigent review approve --project <slug> <KEY>`.
- "request changes on AUTH-LOGIN: missing the error case": `npx taigent review request-changes --project <slug> <KEY> -- <comment>`, with the reviewer's words as the comment (`-- <comment>` may be left out when they give no reason).
- A question or remark with no decision: `npx taigent review comment --project <slug> <KEY> -- <text>`; the verdict stays as it was.

Write the comment in the reviewer's own words and language. When it is unclear which item, or whether a remark is a decision, ask before running anything. A verdict is given on the item's current content: when the item changes later it turns stale and the item is awaiting review again. Exit 2: the key is not in the backlog (perhaps the agent renamed the item) or the command was malformed; nothing was written. Show the message, run `preview` again, and ask the reviewer which item they meant.

Never resolve or edit a comment, and never edit `review.yaml` or `backlog.yaml` yourself: answering the comments is `taiga-plan-backlog`'s job.

Done when every decision and remark the reviewer gave is recorded.

## 4. Validate and report

Run `npx taigent validate --project <slug>`; it checks `review.yaml` too. Exit 4: show each problem and stop.

Tell the reviewer, per key, what was recorded (approved, changes requested, comment). Next steps: `taiga-plan-backlog` answers the open comments (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`); once the backlog is ready, `taiga-apply-backlog`. An approved verdict is not consent to apply: apply still asks for an explicit yes.

---
name: taiga-dashboard
description: "Dashboard of one Taiga project for your role (Developer, Product Owner or Business Analyst), from `taigent metrics`: your role's metrics first. Use for a project's dashboard or metrics such as workload, cycle time, bugs, releases, requirements coverage, items awaiting review or pending clarification."
allowed-tools: Bash(npx taigent metrics *) PowerShell(npx taigent metrics *)
---

# Taiga dashboard

Report the **Dashboard** (`GLOSSARY.md`, section Dashboards) of one project for the user's **Role**: that role's metrics first, the others after them in brief. The read-only `npx taigent metrics --json` computes every figure; this skill only picks them and lays them out (`docs/cli.md` §Metrics holds the contract and what each field means, in the taigent root that `taiga-setup` names). Hand over the questions other skills answer: a sprint's or an epic's progress, or one quick count, to `taiga-status-report`; your own tickets in a period to `taiga-my-tickets`.

## 1. Pick the role

The role is what the user does on the project, in their own words: Developer, Product Owner (PO) or Business Analyst (BA), in any language ("tôi là PO"). It is not their role on the Taiga project: never infer it from Taiga memberships, the git user, earlier sessions or memory. When the request names none, ask once in this turn, offering the three, and wait for the answer.

The role holds for this request only: never write it to a file, a memory, a setting or Taiga. The next dashboard request asks again unless it names the role.

Done when you have one of the three roles from the user's words.

## 2. Pick the project

`metrics` takes the project's slug: the one the user named; when they named none and the working directory holds exactly one `taiga/<slug>/` folder, that one; otherwise ask. Run from the folder that holds `taiga/<slug>/` when there is one: the release targets and the Business Analyst's metrics come from its `project.yaml`, `backlog.yaml`, `state.json` and `review.yaml`.

Done when you have the slug.

## 3. Run `taigent metrics`

Run `npx taigent metrics --project <slug> --json`, alone in its own shell call. It only reads Taiga, one history per story, task and bug, so a large project takes a while.

- Exit 2 with error kind `project`: the slug is not on Taiga or not visible to the user. Say so and ask for the right slug.
- Exit 2 saying `not logged in`, exit 5 naming a refused login, a `TAIGA_*` variable or an expired stored login, or `npx taigent` not found or not taigent's usage: show the error and name `taiga-setup` as the fix. Never ask for a password.
- Exit 4: `taiga/<slug>/project.yaml` is invalid; show its issues and name `npx taigent validate --project <slug>`.
- Any other failure: show the error verbatim and stop.

Done when you hold its JSON.

## 4. Report

Build the report from the JSON alone: every figure as printed, nothing estimated or recomputed beyond picking rows (such as the user's own, `developer.me`). A metric the JSON lacks (a kanban project has no sprint metrics; `unavailable` lists the others) stays out, with the reason in the notes. Write in the user's language, headings and labels included; status names, keys, subjects and sprint names stay as printed. Dates as `DD/MM`; a period by its `name` in `periods` (a week as `DD/MM–DD/MM`); a `rate` as a percentage.

1. **Header**: `# Dashboard <project.name> — <role>`, then one line: `today`, when it was made (`generatedAt`, local time), the cadence (sprints, or weeks for a kanban project) and `developer.me.username`.
2. **The role's metrics**, in the order of the role's section below.
3. **Other metrics**: one line each for the metrics of the other two sections not shown yet, with their headline figure (e.g. velocity of the last sprint, requirements coverage rate). No tables.
4. **Notes**: every `warnings` message and every `unavailable` entry with its message. `backlog-missing`: the metrics that need `taiga/<slug>/backlog.yaml` in the working directory; `backlog-invalid`: run `npx taigent validate --project <slug>`.

### Developer

Yours (`mine`, and rows whose assignee is `developer.me.id`) first, then the team's (`all`):

1. **Workload**: your row of `developer.workload` (open stories, open tasks, points of those stories; no row means no open work), then a table of every row, the unassigned one last.
2. **Cycle time**: `developer.cycleTime`, median days and count, stories and tasks apart; then **Lead time** (`developer.leadTime`) the same way.
3. **Bug** resolution: a table per period of `developer.bugs.periods`: **Resolved bug**s, rejected bugs, median **Resolution time**, **Reopened bug**s and the reopen rate.
4. Work per period: `developer.periods`, stories and tasks assigned and completed.
5. Blocked and overdue items: those of `developer.blocked` and `developer.overdue` whose `assignees` hold your id, by ref, then how many others the team has.

### Product Owner

1. **Release**: one row per release of `productOwner.releaseBurndown.releases`: version, target day (or undeclared), stories closed of total, points closed, total and remaining, and today's `remaining` against `ideal` from its `days`. Then the stories of `multiTagged`, by ref.
2. **Requirements coverage**: `businessAnalyst.requirementsCoverage`, epics covered of total and the rate, then the uncovered epics by key and subject.
3. **Awaiting review**: how many items `businessAnalyst.awaitingReview` holds, unreviewed and stale apart, then each one as `key subject (#ref)`.
4. **Pending clarification**: each item of `businessAnalyst.pendingClarification` with its open comments (`by`, `text`).
5. The current sprint and its health: `productOwner.currentSprint` (stories, tasks and points done of total, day elapsed of total), each `health` signal with its level and reason, `velocity`, completed of planned points per sprint (`planned`), the **Scope change** per sprint (points and stories added and removed), and the bug trend per period (`bugTrend`: created, resolved, rejected, reopened, open).

### Business Analyst

1. **Requirements coverage**: as for the Product Owner, then **Complete acceptance criteria**: `businessAnalyst.acceptanceCriteria`, stories complete of total and the rate, and each incomplete story with its epic and reason (`legacy`, `no-scenario`, or `incomplete-scenarios` with each scenario's missing parts).
2. **Requirement change**: per period of `businessAnalyst.requirementChange`, the number of changes and each story edited as `#ref subject (changes)`.
3. **Awaiting review** and **Pending clarification**: as for the Product Owner.
4. User stories by status: `businessAnalyst.statuses.stories` as a table of status and count, then `notApplied`, the backlog's stories not on Taiga yet.

Done when the report has its header, every metric of the role's section or the reason it is missing, the line per other metric, and every warning and unavailable entry. The report is the whole job: nothing is written to Taiga, the manifests or anywhere else. Backlog fixes go through `taiga-plan-backlog`; verdicts stay the reviewer's.

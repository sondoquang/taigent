---
name: taiga-status-report
description: Report a Taiga project's progress by epic and by sprint (done vs open stories, points, tasks, blocked items), reading Taiga through the Taiga MCP read tools only. Use when the user asks for project status, sprint progress, epic progress or a Taiga report.
allowed-tools: mcp__taiga__listProjects mcp__taiga__getProject mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory mcp__taiga__listMilestones mcp__taiga__getMilestone mcp__taiga__getMilestoneStats mcp__taiga__advancedSearch mcp__taiga__queryHelp mcp__taiga__validateQuery
---

# Taiga status report

Summarise one Taiga project's progress **by sprint** and **by epic**. This skill only reads: the Taiga MCP read tools in `allowed-tools` and the repository's files. It never changes Taiga, never comments, and runs no shell command.

## 1. Pick the project

The project the user named (name, slug or id). Call `mcp__taiga__listProjects` and take its **id** and **slug** from the line `<name> (ID: <id>, Slug: <slug>)`. Ask when the name matches several projects or none.

Done when you have the id and slug.

## 2. Read the sprints

1. `mcp__taiga__listMilestones` with `projectIdentifier: "<slug>"`: every sprint's name, ID, status (`Active`/`Closed`) and dates. "No sprints found" means a kanban-style project: skip to step 3.
2. Pick the sprints to report: the ones the user named; otherwise every `Active` sprint plus the most recently closed one.
3. For each picked sprint:
   - `mcp__taiga__getMilestoneStats` with `milestoneId: "<ID>"`: stories and tasks completed out of total, and the completion rate.
   - `mcp__taiga__getMilestone` with `milestoneId: "<ID>"`: total and closed points, and the "Complete Raw Data (JSON)" block, whose `user_stories` entries give each story's `ref`, `id`, `subject`, `status_extra_info.name`, `is_closed`, `is_blocked`, `total_points` and `epics` (null, or the epics it belongs to with their `subject`).

Take points from `getMilestone`, not `getMilestoneStats`: taiga-mcp-server@1.9.20 prints the stats' total points as `[object Object]`.

## 3. Read the epics and the stories

1. `mcp__taiga__listEpics` with `project: <id>` (the numeric id): each epic's title, ID, status and number of stories.
2. `mcp__taiga__listUserStories` with `projectIdentifier: "<slug>"`: every story as `#<ref>: <subject> (Status: <status>)`. It shows neither epic nor sprint. Stories whose ref is in none of the sprints read in step 2 are **outside those sprints**.
3. Map stories to epics:
   - When the repository has `taiga/<slug>/backlog.yaml` and `taiga/<slug>/state.json`, the backlog lists each epic's stories by key and `state.json` gives each key's Taiga `id`. Call `mcp__taiga__getUserStory` with `userStoryId: "<id>"` (the id, never the `#ref`) for the stories you need: it shows status, epic, sprint, points and tags.
   - Otherwise use the `epics` field of the sprint stories from step 2. Report stories outside the read sprints by status only, with their epic as unknown; say so rather than guessing.

`mcp__taiga__advancedSearch` (syntax: `mcp__taiga__queryHelp`) can answer a filter the user asks for, such as one assignee's stories. With taiga-mcp-server@1.9.20 it prints fields as `[object Object]` and some filters match nothing, so use it only for counts and confirm the items with the list and get tools.

## 4. Report

Use the status names of `docs/taiga/conventions.md` §7 (story `Done`/`Archived` and task `Closed` count as done). Write the report in the user's language:

1. **Project**: name, slug, date of the report.
2. **By sprint**, one row per sprint read: name, dates, status, stories done/total, points closed/total, tasks done/total, completion rate. Under each active sprint, list its open stories (`#ref subject (status)`), blocked ones first.
3. **By epic**, one row per epic: title, epic status, stories done/total where known, and which sprints its stories are in. Add a row "No epic" for stories without one.
4. **Outside the sprints read**: story counts per status.
5. **Gaps**: what the tools could not show (e.g. epics of stories outside the read sprints) and every tool error, verbatim.

Done when every picked sprint and every epic has a row. Then stop: changing statuses, sprints or items is the users' work on Taiga, and backlog changes go through `/taiga-plan-backlog` (Codex: `$taiga-plan-backlog`).

Never call an MCP create, update, link, batch, upload, comment or delete tool in this skill (`docs/taiga/conventions.md` §10).

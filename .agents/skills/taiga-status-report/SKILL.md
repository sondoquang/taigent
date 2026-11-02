---
name: taiga-status-report
description: "Taiga progress report by sprint and by epic: done vs open stories, points, tasks, blocked items. Use for a Taiga project's status, a sprint's or an epic's progress, or a quick count or lookup such as how many epics a project has."
allowed-tools: mcp__taiga__listProjects mcp__taiga__getProject mcp__taiga__listEpics mcp__taiga__getEpic mcp__taiga__listUserStories mcp__taiga__getUserStory mcp__taiga__listMilestones mcp__taiga__getMilestone mcp__taiga__getMilestoneStats mcp__taiga__advancedSearch mcp__taiga__queryHelp mcp__taiga__validateQuery
---

# Taiga status report

Answer from Taiga's own data, **by sprint** and **by epic**, through the Taiga MCP read tools in `allowed-tools` and local files. Questions about **your own** tickets or work in a period ("my tickets last week", "what did I finish in October") belong to the `taiga-my-tickets` skill: hand them over.

Tool names below are those of the `taiga` MCP server (taiga-mcp-server@1.9.20); your agent prefixes them with the server name (Claude Code: `mcp__taiga__listProjects`). When they are missing from your tools, or `listProjects` returns an error, stop and run the `taiga-setup` skill.


## 1. Pick the project

The project the user named (name, slug or id). Call `listProjects` and take its **id** and **slug** from the line `<name> (ID: <id>, Slug: <slug>)`. Ask when the name matches several projects or none.

Done when you have the id and slug.

**Quick question** (one count or list, e.g. "how many epics", "which stories in sprint 3 are blocked"): call only the tools of steps 2–3 that answer it, answer with the figures and the tool they came from, and stop. Everything else gets the full report: steps 2–4.

## 2. Read the sprints

1. `listMilestones` with `projectIdentifier: "<slug>"`: every sprint's name, ID, status (`Active`/`Closed`) and dates. "No sprints found" means a kanban-style project: skip to step 3.
2. Pick the sprints to report: the ones the user named; otherwise every `Active` sprint plus the most recently closed one.
3. For each picked sprint:
   - `getMilestoneStats` with `milestoneId: "<ID>"`: stories and tasks completed out of total, and the completion rate.
   - `getMilestone` with `milestoneId: "<ID>"`: total and closed points, and the "Complete Raw Data (JSON)" block, whose `user_stories` entries give each story's `ref`, `id`, `subject`, `status_extra_info.name`, `is_closed`, `is_blocked`, `total_points` and `epics` (null, or the epics it belongs to with their `subject`).

Take points from `getMilestone`: taiga-mcp-server@1.9.20 prints the stats' total points as `[object Object]`.

Done when every picked sprint has its stats, points and story list, or the project has no sprints.

## 3. Read the epics and the stories

1. `listEpics` with `project: <id>` (the numeric id): each epic's title, ID, status and number of stories.
2. `listUserStories` with `projectIdentifier: "<slug>"`: stories as `#<ref>: <subject> (Status: <status>)`. It shows no tags, epic or sprint, and taiga-mcp-server@1.9.20 returns only Taiga's first page (30 stories): when it returns exactly 30, report its counts as a lower bound. Stories whose ref is in none of the sprints read in step 2 are **outside those sprints**.
3. Map stories to epics:
   - When the working directory has `taiga/<slug>/backlog.yaml` and `taiga/<slug>/state.json`, the backlog lists each epic's stories by key and `state.json` gives each key's Taiga `id`. Call `getUserStory` with `userStoryId: "<id>"` (the id; a `#ref` returns another story or an error) for the stories you need: it shows status, epic, sprint, points and tags.
   - Otherwise use the `epics` field of the sprint stories from step 2; when the user asks about epics, read every sprint with `getMilestone` so more stories carry their epic. Report the remaining stories by status only, with their epic as unknown, and say so: subjects are no evidence of an epic.

`advancedSearch` (syntax: `queryHelp`) takes `projectIdentifier` and `type: "user_stories"` (its default is issues). In taiga-mcp-server@1.9.20 its `status`, `assignee` and date filters compare fields Taiga does not have and match nothing, and it prints fields as `[object Object]`: answer from the list and get tools.

Done when every story read has its epic, or is marked "No epic" or epic unknown.

## 4. Report

A story or task is done when Taiga marks its status closed (`is_closed` in `getMilestone` data). With only a status name, use the default template's closed statuses: story `Done` and `Archived`, task `Closed`. Write the report in the user's language:

1. **Project**: name, slug, date of the report.
2. **By sprint**, one row per sprint read: name, dates, status, stories done/total, points closed/total, tasks done/total, completion rate. Under each active sprint, list its open stories (`#ref subject (status)`), blocked ones first.
3. **By epic**, one row per epic: title, epic status, stories done/total where known, and which sprints its stories are in. Add a row "No epic" for stories without one.
4. **Outside the sprints read**: story counts per status.
5. **Gaps**: what the tools could not show (e.g. epics of stories outside the read sprints) and every tool error, verbatim.

Done when every picked sprint and every epic has a row. The report is the whole job: statuses, sprints and items stay as the team set them on Taiga, and backlog changes go through `taiga-plan-backlog` (Claude Code `/taiga-plan-backlog`, Codex `$taiga-plan-backlog`).

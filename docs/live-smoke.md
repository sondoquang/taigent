# Live smoke test (runbook)

`test/live/taiga-smoke.live.ts` checks `taigent apply` and `taigent upload` against a **real** Taiga project. It
writes data, so a person runs it (ticket #13). It is not part of `npm test`, it is skipped unless
`TAIGENT_LIVE_SMOKE=1`, and the target project is never defaulted. `test/live-smoke.test.ts` (in `npm test`) runs
the same file against the fake Taiga, so it keeps working as the CLI changes.

## What one run does

Every run picks a run id (`<run>`, e.g. `mvxf673h`, printed first) and creates, in the target project:

- epics `SMOKE-<RUN>-EPIC` and `SMOKE-<RUN>-EPIC2`, story `SMOKE-<RUN>-STORY` linked to the first epic, task
  `SMOKE-<RUN>-TASK` under the story (tag `type:chore`, plus `src:smoke-<run>-…` set by apply);
- wiki page `smoke-<run>`, attachment `smoke-<run>-epic.txt` on the first epic and `smoke-<run>-wiki.txt` on the page
  (a few bytes each).

It then reads them back over REST (epic ↔ story link, task parent, wiki content, attachment name/size/sha1),
re-runs `apply --yes` and `upload --yes`, and requires that nothing was written again, that `plan` and
`upload --dry-run` report no change, and that REST still shows exactly one of each item. Items of earlier runs have
other keys, so they never interfere.

## Run it

Needs Node.js 24, `npm ci`, and an account that is a member of the target project with write rights; the project
needs the Epics and Wiki modules on. `TAIGA_API_URL` and `TAIGA_USERNAME`/`TAIGA_PASSWORD` (or `TAIGA_TOKEN`) come from
your environment as for the CLI (`AGENTS.md`, `docs/cli.md`).

PowerShell:

```powershell
$env:TAIGENT_LIVE_SMOKE = "1"
$env:TAIGENT_SMOKE_PROJECT = "test"      # slug of the project to write to
npm run test:live
```

POSIX shell:

```sh
TAIGENT_LIVE_SMOKE=1 TAIGENT_SMOKE_PROJECT=test npm run test:live
```

A pass looks like this (the `ℹ` lines are what you need next):

```
✔ live smoke: apply + upload create linked items, wiki page and attachments; a re-run changes and duplicates nothing
ℹ run mvxf673h on project test: keys SMOKE-MVXF673H-EPIC, SMOKE-MVXF673H-EPIC2, SMOKE-MVXF673H-STORY, SMOKE-MVXF673H-TASK; wiki page smoke-mvxf673h
ℹ check in the web UI: epic #41 (story #42 linked, attachment smoke-mvxf673h-epic.txt), task #43, wiki page smoke-mvxf673h (attachment smoke-mvxf673h-wiki.txt)
ℹ epic tag filter: GET /epics?project=7&tags=src:smoke-mvxf673h-epic returned 1 of 9 epics: applied server-side
```

A failure names the command (with its stdout/stderr) or the item that is missing, duplicated or wrong. Remove
`TAIGENT_LIVE_SMOKE` from your session afterwards (`Remove-Item Env:TAIGENT_LIVE_SMOKE`).

## Check in the web UI

Use the refs from the `check in the web UI` line:

1. Epic `#<ref>`: the story is listed under related user stories, and the attachment `smoke-<run>-epic.txt` is
   there and downloads with the text `taigent live smoke <run>: epic attachment`.
2. Story `#<ref>`: shows the epic, and task `#<ref>` in its task list; the description ends with an
   "Acceptance criteria" checklist.
3. Wiki → page `smoke-<run>`: content shows, attachment `smoke-<run>-wiki.txt` is there and downloads intact.
4. No second copy of any of them (search the tag `src:smoke-<run>-epic` etc. in the backlog/epics list).

## Answer the open questions

**Does `GET /epics` filter by tag on the server?** taiga-back's source says yes (`TagsFilter` is in the epic list's
`filter_backends`, taiga/projects/epics/api.py; `tags=a,b` keeps items with any listed tag, exact match), and the
test fake behaves that way. The `epic tag filter` line checks that the instance does too:

- `applied server-side`: only the run's epic came back, Taiga honours `tags` on epics.
- `ignored`: every epic of the project came back (an older or patched server).
- `inconclusive`: record the two counts as printed.

Either way taigent stays correct: it reads all items of a project (every `src:` tag is needed to find orphans) and
matches `src:` tags client-side.

**What upload size does the server accept?** The optional probe uploads one zero-filled attachment of
`TAIGENT_SMOKE_UPLOAD_PROBE_BYTES` bytes to a wiki page `smoke-<run>-probe` and prints
`upload limit: <n> bytes accepted` or `upload limit: <n> bytes rejected (HTTP 413)`. Run the probe alone (the
option must come before the file):

```powershell
$env:TAIGENT_LIVE_SMOKE = "1"; $env:TAIGENT_SMOKE_PROJECT = "test"
$env:TAIGENT_SMOKE_UPLOAD_PROBE_BYTES = "104857600"   # 100 MiB
node --test --test-name-pattern=probe test/live/taiga-smoke.live.ts
```

Start near the taiga-docker default (`client_max_body_size 100M`): e.g. 10 MiB (`10485760`), 50 MiB (`52428800`),
100 MiB (`104857600`), then narrow down between the largest accepted and the smallest rejected size. The request body
is a few hundred bytes larger than the file (multipart fields), so a file just under the proxy limit can still be
rejected. If the server answers something other than 413 (e.g. a 400 from Taiga itself), the probe fails and prints
the CLI output: record that too. If you can ask the server admin, the nginx `client_max_body_size` (and taiga-back
`MAX_UPLOAD_FILE_SIZE`, if set) is the authoritative answer.

**Record the answers** in a comment on issue #13 (run id, the `ℹ` lines, the UI checklist result, the accepted and
rejected probe sizes), and update `docs/research/taiga-agent-automation.md`: §4 (the `[UNVERIFIED]` note about epic tag
filtering) and §5 row 5 (upload limit), replacing `[UNVERIFIED]` with what you observed and the date.

## Clean up

taigent never deletes anything. Delete the run's items by hand in the web UI if you do not want to keep them: the
epics, story and task tagged `src:smoke-<run>-…`, the wiki pages `smoke-<run>` and `smoke-<run>-probe` and their
attachments (probe attachments can be large).

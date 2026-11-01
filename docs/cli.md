# `taigent` CLI

Headless CLI that applies declarative manifests to Taiga through its REST API. Agents and skills call it
through the shell; it is the only path for writes to Taiga (MCP stays read-only).

## Running

Requires Node.js 24+ (runs the TypeScript sources directly, no build step).

```sh
npm install
npm run taigent -- plan --project my-project      # works in PowerShell and POSIX shells
npx taigent plan --project my-project             # same, via the package bin
```

## Environment

| Variable | Meaning |
|---|---|
| `TAIGA_API_URL` | API base URL including `/api/v1`, e.g. `https://taiga.example.com/api/v1` |
| `TAIGA_USERNAME`, `TAIGA_PASSWORD` | Login (`POST /auth`, type `normal`). Required unless `TAIGA_TOKEN` is set |
| `TAIGA_TOKEN` | Access token used instead of username/password (sent as `Authorization: Bearer`) |
| `TAIGENT_MANIFESTS_DIR` | Manifests root, default `./taiga` (relative to the working directory) |
| `TAIGENT_RETRY_UNIT_MS` | Milliseconds per second of 429 backoff, default `1000` (tests set it low) |

Authentication and retries (all in `TaigaClient`, so every command gets them):

- **401:** the client renews the access token once and retries the request: `POST /auth/refresh` with the
  refresh token from the login, else (refresh rejected, or `TAIGA_TOKEN` without a refresh token) a new
  login with `TAIGA_USERNAME`/`TAIGA_PASSWORD` when set. If that is impossible or the retry gets 401 again,
  the run fails (exit 5) naming the URL and the variable to check (`TAIGA_TOKEN` or
  `TAIGA_USERNAME and TAIGA_PASSWORD`).
- **429:** up to 5 retries per request, waiting `Retry-After` (seconds or HTTP date) when Taiga sends it,
  else 1, 2, 4, 8, 16 units; one wait is capped at 60 units (unit = `TAIGENT_RETRY_UNIT_MS`).
- Missing variables are a configuration error (exit 2) naming them, e.g.
  `missing environment variable(s): TAIGA_PASSWORD (or set TAIGA_TOKEN instead)`. So is a `TAIGA_API_URL` with
  credentials in it (`https://user:password@…`): put them in `TAIGA_USERNAME`/`TAIGA_PASSWORD` instead (the message
  never repeats the URL).

Credentials and tokens are never printed: Taiga error bodies are included in messages, but `TAIGA_PASSWORD`,
`TAIGA_TOKEN`, the password of a `user:password@` in `TAIGA_API_URL`, and every access/refresh token the client
obtains are replaced by `[redacted]` in everything the CLI writes: stdout, stderr, `--json` and the stack trace of
an internal error (exit 1). One `Secrets` registry (`src/secrets.ts`) is shared by the CLI and the client;
`test/resilience.test.ts` checks every output path, including internal errors and URL credentials.

## Manifest layout

One directory per Taiga project, named by its slug, committed to git:

```
taiga/<slug>/
  backlog.yaml   # desired epics → stories → tasks
  docs.yaml      # wiki pages + attachments (optional)
  state.json     # written by apply: key → Taiga id/ref/version (commit it)
```

`backlog.yaml`:

```yaml
epics:
  - key: AUTH            # required, unique across epics, stories and tasks; uppercase letters/digits/dashes
    subject: Authentication
    description: Users can sign in.   # optional
    tags: [type:feature, area:auth]   # optional
    stories:                          # optional; each story is linked to this epic
      - key: AUTH-LOGIN
        subject: User can log in
        description: As a user I want to log in.    # optional
        acceptance_criteria:                         # optional
          - Wrong password shows an error
        spec: docs/specs/auth.md                     # optional link/path to the spec
        tags: [type:feature]
        custom_attributes:                           # optional, on epics, stories and tasks
          Due note: before launch                    # attribute name (as on Taiga) → string, number or boolean
        tasks:                                       # optional; created under this story
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            description: POST /login returns a session.   # optional
            tags: []                                      # optional
```

Unknown fields are rejected (there is no status, assignee, sprint or points field: those belong to the people
doing the work). A story's Taiga description is rendered from a template:

```
<description>

## Acceptance criteria

- [ ] <criterion>

Spec: <spec>
```

Empty parts are left out.

Names, tags, keys, wiki slugs and attachment names follow `docs/taiga/conventions.md`; each rule there has the
`rule` id that validation errors report. Keys are unique across epics, stories and tasks.

`docs.yaml` (paths are relative to the directory of `docs.yaml` and may point outside it, so documents are referenced
where they already are, e.g. `../../docs/specs/auth.md`):

```yaml
wiki:
  - slug: spec-auth                  # kebab-case, unique
    file: pages/spec-auth.md         # Markdown, must exist
attachments:
  - target: AUTH-LOGIN               # an epic, story or task key, or wiki:<slug> (a wiki page above, or wiki:home)
    file: files/auth-login-flow.pdf  # must exist; its name is the attachment name on Taiga
    description: Login flow          # optional
```

## Identity and state

Every item created on Taiga gets the tag `src:<key>` (lowercase, because Taiga lowercases tags). That tag
is the source of truth: plan/apply read the project's epics, stories and tasks back and match them by tag, so a
deleted or stale `state.json` never causes duplicates. `state.json` is a cache, rewritten by every `apply --yes`
(`type` is `epic`, `story` or `task`):

```json
{
  "project": { "id": 7, "slug": "test" },
  "items": { "AUTH": { "type": "epic", "id": 12, "ref": 3, "version": 1 } }
}
```

## Reconciliation

- **Create**: missing items, in dependency order: each epic, then each of its stories, the story's epic link,
  and the story's tasks (created with `user_story` = the parent story).
- **Link**: a story is linked to its epic with `POST /epics/{id}/related_userstories`, after
  `GET /epics/{id}/related_userstories` (read for every epic with a `src:` tag) shows the link is missing. Existing
  links are never removed.
- **Update**: apply manages only `subject`, `description` and `tags`, and a task's parent story. When they differ
  from the manifest it PATCHes them with the item's current `version` (OCC). Tags are only added: tags people put on
  Taiga stay, and removing a tag from the manifest does not remove it from Taiga. Status, assignee, sprint, points and
  ordering are never sent.
- **Moves**: a task placed under another story in the manifest is an `update` with `changes.parent`; apply PATCHes
  `{user_story, version}` (taiga-back then puts the task in that story's sprint, `TaskViewSet.pre_save`). A story
  placed under another epic gets a `link` to the new epic; a story can belong to several epics on Taiga
  (`RelatedUserStory` is unique per epic and story only), so the link to the old epic stays and `plan` lists it under
  `staleLinks` (not a change, never removed: unlink it on Taiga by hand if obsolete). Only links to epics with a `src:`
  tag are reported; links people made to their own epics are left alone.
- **Custom attribute values**: an item's `custom_attributes` are matched to the project's attributes of that item
  type by exact name (`GET /projects/by_slug` lists them; bootstrap creates them from `project.yaml`). `plan` reads
  `GET /{epics,userstories,tasks}/custom-attributes-values/{id}` of existing items that declare values and lists the
  declared values that differ. `apply` writes them with `PATCH …/custom-attributes-values/{id}
  {attributes_values, version}` (keys are attribute ids as strings; values objects have their own `version`, read
  by plan for existing items, so a value changed on Taiga meanwhile is a `conflict`). Taiga replaces the whole
  object, so apply sends the current values plus the manifest's: values of undeclared attributes stay, and removing
  a value from the manifest does not clear it on Taiga. New items get their values right after creation.
  An attribute name the project does not define fails `plan`/`apply` before any write, with exit 5 (Taiga was
  contacted to learn the names, so it is not a manifest error, exit 4), listing every unknown name with its key
  and the names that exist.
- **Orphans**: items carrying a `src:` tag whose key is no longer in the manifest are listed by `plan` and never
  deleted. They are not changes (they do not make `plan` exit 3).

## Commands

Common options: `--project <slug>` (required except for `validate` and `skills`), `--json` (machine-readable stdout),
`--yes`, `--dry-run`, `-h/--help`. `--dry-run` lists the operations a writing command (`bootstrap`, `apply`, `upload`)
would run and writes nothing, not even `state.json`; it exits 3 when there are changes, 0 otherwise (`apply --dry-run`
is the same as `plan`). Without `--yes` or `--dry-run`, a writing command prints the same operations, writes nothing
and exits 2 when there are changes.

- `taigent validate [--project <slug>] [--json]`: checks every manifest present in `taiga/<slug>/` (all project
  directories without `--project`) against the schema and the conventions. Offline: needs no `TAIGA_*` variable
  and never contacts Taiga. Exit 0 when valid, 4 otherwise. `--json` prints
  `{ "valid": true, "projects": [{ "slug", "files": ["taiga/demo/backlog.yaml", …] }] }`.
- `taigent plan --project <slug> [--json]`: reads Taiga, prints the operations `apply` would run and the
  orphans. Never writes.
- `taigent apply --project <slug> --yes [--json]`: runs the plan in order, writing `state.json` after each
  write to Taiga (a failed run resumes where it stopped). It stops at the first error, naming the operation and
  key. Without `--yes` it prints the plan, writes nothing (not even `state.json`) and exits 2 when there are
  changes.

`plan --json` prints a `Plan`; operations are `create`, `update`, `link` or `skip`:

```json
{
  "project": { "id": 7, "slug": "test" },
  "changes": true,
  "summary": { "create": 2, "update": 1, "link": 1, "skip": 1 },
  "operations": [
    { "action": "skip", "type": "epic", "key": "AUTH", "id": 12, "ref": 3, "version": 1 },
    { "action": "create", "type": "story", "key": "AUTH-LOGIN", "parent": "AUTH",
      "fields": { "subject": "User can log in", "description": "…", "tags": ["type:feature", "src:auth-login"] } },
    { "action": "link", "type": "story", "key": "AUTH-LOGIN", "epic": "AUTH" },
    { "action": "create", "type": "task", "key": "AUTH-LOGIN-API", "parent": "AUTH-LOGIN",
      "fields": { "subject": "Login endpoint", "description": "", "tags": ["src:auth-login-api"] } },
    { "action": "update", "type": "story", "key": "AUTH-LOGOUT", "id": 15, "ref": 6, "version": 4,
      "changes": { "subject": { "from": "Log out", "to": "User can log out" },
                   "tags": { "from": ["src:auth-logout", "urgent"], "to": ["src:auth-logout", "urgent", "type:feature"] } } }
  ],
  "orphans": [ { "type": "task", "key": "AUTH-OLD", "id": 20, "ref": 9, "subject": "Old task" } ],
  "staleLinks": [ { "key": "AUTH-LOGOUT", "id": 15, "ref": 6, "epic": "ACCOUNT", "epicId": 13, "epicRef": 4 } ]
}
```

`create.parent` is the epic key (story) or story key (task). `update.changes` holds only the fields that differ; a
moved task has `changes.parent: { from: "<story key>" | null, to: "<story key>" }` (`null`: in no taigent story).
`staleLinks` lists stories still linked to a taigent epic other than their manifest epic (`epic`: that epic's key).
Custom attribute values add `custom_attributes: { "<name>": value }` to `create`, and
`changes.custom_attributes: { from: { "<name>": value | null }, to: { "<name>": value }, version }` to `update`
(`null`: not set on Taiga; `version`: the values object's). An update of values alone does not PATCH the item.

`apply --yes --json` prints an `ApplyReport`: `{ project, operations: [{ action, type, key, id, ref, epic?, result }],
summary: { created, updated, linked, unchanged } }`; `result` is `created`, `updated`, `linked` or `unchanged`, and
`epic` (the epic key) is set on `link` operations, whose `id`/`ref` are the story's.

Errors print `taigent: <message>` on stderr; with `--json`, stdout also gets
`{ "error": { "kind": "usage" | "validation" | "taiga" | "conflict", "message", "issues"?, "status"?, "key"? } }`.
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].stories[0].key` / `key-unique`.
`conflict` means Taiga refused an update because the item changed on Taiga after apply read it (OCC); `key`
names the item, nothing was overwritten, and re-running `plan` shows the new state.
The text form is `<file>: <path>: <message> [<rule>]`. `plan`/`apply` validate the whole project directory the
same way (and require `backlog.yaml`) before contacting Taiga.

## Bootstrap

`taigent bootstrap --project <slug> (--yes | --dry-run) [--json]` creates the project declared in
`taiga/<slug>/project.yaml`, or completes an existing one. Without `--yes`/`--dry-run` it prints the operations and
exits 2 when there are changes. It never creates project templates (superuser only), and never disables, renames
or deletes anything: a re-run on an existing project only fills gaps.

`project.yaml` (field rules: `docs/taiga/conventions.md`; unknown fields are rejected):

```yaml
name: Acme - Portal                 # required, "<Client/Area> - <Product>"
slug: acme-portal                   # required, = Taiga's slug of the name = the directory name
description: Customer portal.       # required (Taiga requires it)
template: scrum                     # required, scrum | kanban (looked up in GET /project-templates)
is_private: true                    # optional, default true
modules: [epics, wiki, kanban]      # required, enabled modules: epics backlog kanban issues wiki (epics, wiki mandatory)
tags:                               # optional
  - name: type:feature              # type:feature|bug|chore or area:<kebab>
    color: "#2E7D32"                # optional, defaults to (and must equal) the tag's standard color
custom_attributes:                  # optional, per item type: epic | story | task (as in backlog.yaml and plans)
  task:
    - name: Estimate (h)            # required, unique per item type
      description: Hours of work    # optional
      type: number                  # optional: text (default) multiline richtext date url checkbox number
members:                            # optional
  - username: alice                 # exactly one of username / email
    role: Back                      # Taiga role name or slug, from the template/project roles
  - email: bob@example.com
    role: Front
wiki_home: |                        # optional Markdown for the wiki page `home`
  # Acme Portal
```

Steps, in order (each is `create`, `update` or `skip` in the plan):

| Step | Taiga call | Gap filled when |
|---|---|---|
| project | `POST /projects {name, description, creation_template, is_private}` | no project has the slug (`GET /projects/by_slug`) |
| modules | `PATCH /projects/{id} {is_<module>_activated: true}` | a listed module is off (templates ship with Epics off) |
| tag | `POST /projects/{id}/create_tag {tag, color}`; `edit_tag {from_tag, color}` | tag missing; tag exists (e.g. used by items) with another color |
| custom-attribute | `POST /{epic,userstory,task}-custom-attributes {project, name, description, type}` (Taiga's names for epic, story, task) | no attribute with that name |
| membership | `POST /memberships {project, role, username}` (role id looked up by name) | username not a member / e-mail not invited |
| wiki | `POST /wiki {project, slug: "home", content}` | `GET /wiki/by_slug` finds no `home` (an existing page is left alone) |

Refusals (exit 5, nothing written): the slug exists but `i_am_admin` is false (`status: 403`); a member's role is
not defined by the template/project; the template is unknown. Taiga derives the slug itself (read-only on
`POST /projects`, possibly prefixed with the owner username): if the created slug differs, bootstrap stops with
exit 5 after recording the real id/slug in `state.json`, and later runs refuse to create a second project.

`state.json` gets `project: { id, slug }` as soon as the project exists (backlog `items` are preserved).
`bootstrap --dry-run --json` prints a `BootstrapPlan`:

```json
{
  "project": { "id": null, "slug": "acme-portal", "name": "Acme - Portal", "exists": false },
  "changes": true,
  "summary": { "create": 3, "update": 1, "skip": 0 },
  "operations": [
    { "action": "create", "type": "project", "template": "scrum",
      "fields": { "name": "Acme - Portal", "description": "Customer portal.", "creation_template": 1, "is_private": true } },
    { "action": "update", "type": "modules", "modules": ["epics"], "fields": { "is_epics_activated": true } },
    { "action": "create", "type": "tag", "name": "type:feature", "color": "#2E7D32" },
    { "action": "create", "type": "membership", "member": "alice", "role": "Back" }
  ]
}
```

Other operation shapes: `{ action, type: "custom-attribute", itemType, name, fields: { name, description, type } }`,
`{ action: "update", type: "tag", name, color, current }`, `{ action, type: "wiki", slug, content? }`,
`{ action: "skip", type: "project", id, slug }`. `bootstrap --yes --json` prints a `BootstrapReport`:
`{ project: { id, slug }, operations: [<operation> + { result: "created" | "updated" | "unchanged" }],
summary: { created, updated, unchanged } }`.

## Upload

`taigent upload --project <slug> (--yes | --dry-run) [--json]` brings Taiga's wiki pages and attachments to what
`taiga/<slug>/docs.yaml` declares (schema above; `backlog.yaml` is needed when attachments target item keys). Like
`bootstrap`, without `--yes`/`--dry-run` it prints the operations and exits 2 when there are changes; `--dry-run`
exits 3 when there are changes, 0 otherwise. It never deletes, renames or edits an existing attachment, and writes
no `state.json`.

- **Wiki pages** are upserted by slug: `GET /wiki/by_slug?slug=&project=`; missing → `POST /wiki
  {project, slug, content}`; content different from the Markdown file → `PATCH /wiki/{id} {content, version}`
  (OCC: if someone edited the page meanwhile, the run stops with a `conflict` error, `key: "wiki:<slug>"`, nothing
  overwritten); same content → skipped. Re-runs never create a second page.
- **Attachment targets**: an item key is resolved to the epic/story/task tagged `src:<key>` (state.json is not
  needed); if `apply` has not created it yet, upload fails before writing anything (exit 5). `wiki:<slug>` is a page of
  docs.yaml (created first in the same run) or an existing page such as `home`.
- **Attachments** are compared with `GET /{epics,userstories,tasks,wiki}/attachments?object_id=&project=`: one with
  the same name (the file's base name) and the same `size` and `sha1` is skipped. Otherwise the file is uploaded with
  `POST /{epics,userstories,tasks,wiki}/attachments` as `multipart/form-data` (`object_id`, `project`, `description`,
  `attached_file`). When attachments with that name but other content exist (the local file changed), the new version
  is added and the output says the previous attachment stays on Taiga (`previous` in JSON); remove it by hand if it
  is obsolete. Changing only `description` in docs.yaml does not update an uploaded attachment.
- **Large files**: attachments are hashed and uploaded as streams from disk (the upload body is a file-backed `Blob`),
  so a file is never read into memory as a whole and nothing passes through an agent's context; wiki Markdown is read
  as a string because Taiga takes it in a JSON body. When the server refuses an upload as too large (HTTP 413, e.g.
  nginx `client_max_body_size`, 100 MB in taiga-docker), the run stops with exit 5 and a message naming the file and
  its size; `--json` adds `"file"` to the error. Uploads before it are kept and skipped by the next run.

The run stops at the first error, naming the operation. `upload --dry-run --json` prints an `UploadPlan`
(`file` paths are relative to the working directory):

```json
{
  "project": { "id": 7, "slug": "demo" },
  "changes": true,
  "summary": { "create": 2, "update": 0, "skip": 1 },
  "operations": [
    { "action": "create", "type": "wiki", "slug": "spec-auth", "file": "taiga/demo/pages/spec-auth.md" },
    { "action": "create", "type": "attachment", "target": "wiki:spec-auth", "targetType": "wiki", "objectId": null,
      "name": "glossary.pdf", "file": "taiga/demo/files/glossary.pdf", "size": 1024, "sha1": "…", "description": "",
      "previous": [] },
    { "action": "skip", "type": "attachment", "target": "AUTH-LOGIN", "targetType": "story", "objectId": 15, "id": 31,
      "name": "auth-login-flow.pdf", "file": "taiga/demo/files/auth-login-flow.pdf", "size": 2048, "sha1": "…",
      "description": "Login flow" }
  ]
}
```

Wiki `update`/`skip` operations add `id` (and `version` for `update`); `objectId` is null for a page created in the
same run; `previous: [{ id, size, sha1 }]` lists the same-name attachments that stay on Taiga. `upload --yes --json`
prints an `UploadReport`: `{ project, operations: [<operation> + { id, result: "created" | "updated" | "unchanged" }],
summary: { created, updated, unchanged } }`, where `id` is the wiki page or the (new) attachment.

## Skills

The agent skills that drive this CLI are `taiga-*` [Agent Skills](https://agentskills.io/specification), one
canonical copy in `.agents/skills/` (Codex reads it) and a byte-identical copy in `.claude/skills/` (Claude Code
reads it). Edit only `.agents/skills/taiga-*`, then copy:

- `taigent skills sync [--json]`: replaces every `.claude/skills/taiga-*` copy that differs from its source and
  removes copies whose source is gone. Other skills (the vendored ones without the `taiga-` prefix) are never
  read or written.
- `taigent skills check [--json]`: exit 0 when the copies match, 3 when they differ (listing each file as
  `missing`, `changed` or `extra`). `npm test` runs it on the repository, so a forgotten sync fails the suite.

Both work on the working directory (run them from the repository root; no `.agents/skills` there is exit 2), are
offline and need no `TAIGA_*` variable. `skills check --json` prints
`{ "inSync": false, "skills": ["taiga-apply-backlog", …], "differences": [{ "skill", "file", "status" }] }`
(`file` is relative to the skill directory); `skills sync --json` prints `{ "skills", "synced", "removed" }`
(skill names).

| Skill | Invocation | Does |
|---|---|---|
| `taiga-plan-backlog` | Model or user (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`, `policy.allow_implicit_invocation: true`) | Spec/PRD → reads what exists (`taigent plan --json`, read-only on Taiga; MCP read tools for hand-made work) → edits `taiga/<slug>/backlog.yaml` in place (keeps keys), ends with `taigent validate`. Writes files only |
| `taiga-apply-backlog` | User only: `disable-model-invocation: true` (Claude), `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex) | `taigent plan` → shows it → asks → `taigent apply --yes` after an explicit yes |
| `taiga-bootstrap-project` | User only (as above) | Writes or checks `taiga/<slug>/project.yaml`, `taigent validate` → `taigent bootstrap --dry-run` → asks → `taigent bootstrap --yes` |
| `taiga-upload-docs` | User only (as above) | Updates `taiga/<slug>/docs.yaml` (referencing documents where they already are, no copies), `taigent validate` → `taigent upload --dry-run` → asks → `taigent upload --yes` |
| `taiga-status-report` | Model or user | Read-only report by sprint and by epic through Taiga MCP read tools (`listMilestones`, `getMilestone`, `getMilestoneStats`, `listEpics`, `listUserStories`, `getUserStory`, `advancedSearch`); runs no shell command |

Their `allowed-tools` pre-approve only `npx taigent validate|plan|apply|bootstrap|upload` (as `Bash(...)` and, for
Claude Code's Windows PowerShell tool, `PowerShell(...)` rules) and Taiga MCP read tools; every skill that
pre-approves a writing command (`apply`, `bootstrap`, `upload`) is user-only on both agents (`test/skills.test.ts`
enforces both rules). They grant, not restrict: the gate before `--yes` is the skill's explicit confirmation step.
Codex's skill docs do not document `allowed-tools`; there, approvals come from `.codex/config.toml`, the sandbox, the
execpolicy rule `.codex/rules/taigent.rules` and, in headless runs, the shell hook `.codex/hooks/taigent-shell-guard.mjs`
(`docs/headless.md`).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, credentials in `TAIGA_API_URL`, `apply`/`bootstrap`/`upload` with changes but no `--yes`, `skills` outside a repository root |
| 3 | `plan` or `--dry-run` found changes; `skills check` found differing copies |
| 4 | Manifest invalid or missing; Taiga was not contacted |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, unknown project, version conflict, custom attribute name not defined on the project; bootstrap refusals (not admin, unknown role/template, slug mismatch) |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`); one review gate (`reviewGate`) and one text form for every plan and report |
| Manifest | `src/manifest/` | `loadManifests`/`MANIFESTS` registry (`manifests.ts`), `loadBacklog`, `loadDocs`, conventions rules (`conventions.ts`), `readManifestYaml`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Items | `src/items.ts` | `ITEM_TYPES`/`ItemType` (`epic`, `story`, `task`): the one item vocabulary outside the client |
| Secrets | `src/secrets.ts` | `Secrets` (`add`, `redact`): what no output may show, shared by the CLI (environment) and the client (tokens) |
| Operations | `src/operations.ts` | the shape every plan/execute command shares: `Action` → `RESULT`, `summarize(actions, operations)` → `{ changes, summary }`, `tally` for reports, `FILL_ACTIONS` (bootstrap, upload) |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`, PATCH with `version`; item methods keyed by `ItemType`: `listItems`/`createItem`/`updateItem`, `getAttributeValues`/`updateAttributeValues`, `listAttachments`/`uploadAttachment`), the only place that maps item types to Taiga's endpoint names (`TAIGA_ITEM`), `TaigaError`, `TaigaConflictError` (OCC refusal; `key` set by the command that planned the write) |
| Remote reader | `src/remote.ts` | `readBacklogRemote(backlog, client, slug)`: reads the project, its items, epic links and attribute values `buildPlan` needs |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote)` → operations + orphans, `describePlanOperation`, `srcTag(key)` |
| Executor | `src/executor.ts` | `executePlan(plan, client, statePath, customAttributes)`, `describeAppliedOperation` |
| Bootstrap | `src/bootstrap.ts`, `src/manifest/project.ts` | `loadProject`; `readBootstrapRemote(manifest, client, statePath)`, pure `planBootstrap(manifest, remote)`, `executeBootstrap(plan, project, client, statePath)` |
| Upload | `src/upload.ts` | `readUploadRemote(docs, backlog, client, slug)` (reads Taiga, hashes files), pure `planUpload(docs, remote, cwd)`, `executeUpload(plan, client, cwd)`, `UploadTooLargeError` (carries `file`) |
| Skills | `src/skills.ts` | `compareSkills(root)`, `syncSkills(root)`: `.agents/skills/taiga-*` → `.claude/skills/taiga-*` |

Every plan/execute command has the same three steps: a reader (`read*Remote`, all I/O), a pure planner, an executor.
The CLI only wires them (`runPlan`, `runBootstrap`, `runUpload`) and prints.

Adding a manifest kind: write `load<Kind>(path, context)` that reads with `readManifestYaml`, reports every
problem through an `issue(path, rule, message)` sink (reusing the `check*` functions of `conventions.ts`) and
throws one `ManifestError`; then add its type to `Manifests` and an entry to `MANIFESTS` in `manifests.ts`, in
dependency order (`context.loaded` holds the manifests loaded before it, `context.invalid` the ones that failed).
`validate` and every command then pick it up. New rules go in `conventions.ts` and `docs/taiga/conventions.md`.

## Tests

`npm test` (Node's built-in runner) and `npm run typecheck`. Tests only go through the CLI seam:
`test/support/harness.ts` (`startHarness(t)`) spawns `bin/taigent.js` in a temp working directory against
`test/support/fake-taiga.ts` (`startFakeTaiga()`), an in-process fake of the Taiga API that validates
payloads like Taiga (and additionally rejects unknown fields). Extend the fake rather than mocking modules.

Fake API used by the tests (`FakeTaiga` in `test/support/fake-taiga.ts`):

- `fake.url` (TAIGA_API_URL, includes `/api/v1`) and `fake.user` (`{ id, username, password, email }`, the account
  `POST /auth` accepts; the harness logs in with it).
- Seeding: `addEpic`, `addUserStory`, `addTask` (`{ project, subject, description?, tags? }`, plus `user_story?` for
  tasks), `addEpicRelatedUserStory(epic, story)`; bootstrap fixtures `addUser`, `addProject({ slug, name?, members?,
  admins?, is_private?, modules?, tagsColors? })`, `addCustomAttribute`, `addMembership`, `addWikiPage`; upload fixtures
  `addAttachment({ project, objectType: "epics" | "userstories" | "tasks" | "wiki", object_id, name, content })`.
- Edits like a Taiga user (bump `version`, recorded for OCC): `editItem(item, changes)`, `editWikiPage(page, changes)`,
  `editAttributeValues(itemType, itemId, values)`.
- `fake.state`: what Taiga holds, the place to assert outcomes. `epics`, `userStories`, `tasks` (tags lowercased),
  `epicRelatedUserStories` (`{ epic, user_story, order }`), `projects` (`modules`, `tagsColors`, `members`, `admins`),
  `users`, `roles` (`{ id, project, name, slug }`), `memberships` (`{ project, role, user, email }`), `customAttributes`
  (`{ itemType, project, name, description, type }`), `customAttributeValues` (`{ itemType, item, version,
  attributes_values }`), `wikiPages` (`{ project, slug, content, version }`), `attachments` (with the stored `content`
  bytes), `templates` (`scrum` id 1 and `kanban` id 2, Epics off).
- `fake.requests`: every request received, in order, as `{ method, path, query, headers, body, at }`: `path` is below
  `/api/v1`, `query` a `URLSearchParams`, `body` the parsed JSON (a `MultipartForm { fields, files }` for multipart
  uploads; POST /auth bodies hold the password, never print them), `at` the `performance.now()` of arrival. Assert
  outcomes on `fake.state`; use `fake.requests` only for what is a contract: the payload of a documented call (e.g.
  PATCH carries `version`), "no write" / "no request" checks, and the auth and retry behaviour documented under
  Environment (401 → `/auth/refresh` → new login order, at most 5 retries per 429, `Retry-After` waits via `at`).
- Failure injection: `fake.intercept({ method, path, status, body?, bodyFrom?, headers?, after?, times? })` answers the
  matching request(s) with a canned reply (`path` a string or RegExp below `/api/v1`; `bodyFrom(request)` builds the body
  from the recorded request, e.g. to echo credentials; `headers` e.g. `retry-after`; `after` lets that many through
  first; `times` default 1). `fake.onRequest({ method, path, run, times? })` runs a callback just before a request is
  handled (e.g. `fake.editItem(story, { subject })` to simulate a concurrent edit).
- Tokens: `fake.issueToken()` returns a valid access token without a login (for `TAIGA_TOKEN`);
  `fake.expireTokens({ after?, refresh? })` expires all access tokens after `after` more authenticated requests (and
  revokes refresh tokens with `refresh: true`); `fake.issuedTokens` lists every access and refresh token issued, for
  leak checks.
- `fake.settings`: `projectSlugPrefix = true` mimics DEFAULT_PROJECT_SLUG_PREFIX; `maxBodyBytes = n` answers any larger
  request body with nginx's HTML 413 page, like Taiga's reverse proxy (`client_max_body_size`).

Fidelity: the fake implements Taiga's OCC (PATCH needs `version`; a stale one fails only when the same fields changed
meanwhile), 30-item pagination unless `x-disable-pagination`, taiga-back's `tags=a,b` filter on the epic, story and
task lists (items with any listed tag, exact match; taigent itself does not use it and matches `src:` tags client-side),
and the post-save empty custom attribute values object (version 1) of every epic/story/task, served at
`/{epics,userstories,tasks}/custom-attributes-values/{id}` (keys must be ids of the project's attributes of that type;
PATCH replaces the object and needs its own `version`). It parses `multipart/form-data` with Node's own parser
(`Response#formData`), computes attachment `size`/`sha1` from the bytes like taiga-back and rejects unknown form fields.

Live smoke test: `npm run test:live` runs `test/live/*.live.ts` against a real Taiga project. It is opt-in
(`TAIGENT_LIVE_SMOKE=1`, target `TAIGENT_SMOKE_PROJECT`), never part of `npm test`, and only run by a person:
see `docs/live-smoke.md`. `test/live-smoke.test.ts` runs it against the fake in `npm test`.

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
  `missing environment variable(s): TAIGA_PASSWORD (or set TAIGA_TOKEN instead)`.

Credentials and tokens are never printed: Taiga error bodies are included in messages, but any password,
token or refresh token the client holds is replaced by `[redacted]` first (tested on every output path).

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

`docs.yaml` (paths are relative to the directory of `docs.yaml`):

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
  `GET /epics/{id}/related_userstories` shows the link is missing. Existing links are never removed.
- **Update**: apply manages only `subject`, `description` and `tags`. When they differ from the manifest it PATCHes
  them with the item's current `version` (OCC). Tags are only added: tags people put on Taiga stay, and removing
  a tag from the manifest does not remove it from Taiga. Status, assignee, sprint, points and ordering are never
  sent.
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

Common options: `--project <slug>` (required except for `validate`), `--json` (machine-readable stdout), `--yes`,
`--dry-run`, `-h/--help`. `--dry-run` lists the operations a writing command (`bootstrap`, `apply`) would run and writes nothing, not even
`state.json`; it exits 3 when there are changes, 0 otherwise (`apply --dry-run` is the same as `plan`).

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
  "orphans": [ { "type": "task", "key": "AUTH-OLD", "id": 20, "ref": 9, "subject": "Old task" } ]
}
```

`create.parent` is the epic key (story) or story key (task). `update.changes` holds only the fields that differ.
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
custom_attributes:                  # optional, per item type: epic | userstory | task
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
| custom-attribute | `POST /{epic,userstory,task}-custom-attributes {project, name, description, type}` | no attribute with that name |
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
| `taiga-plan-backlog` | Model or user (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`) | Spec/PRD → edits `taiga/<slug>/backlog.yaml` in place (keeps keys), ends with `taigent validate`. Writes files only |
| `taiga-apply-backlog` | User only: `disable-model-invocation: true` (Claude), `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex) | `taigent plan` → shows it → asks → `taigent apply --yes` after an explicit yes |

Their `allowed-tools` pre-approve only `npx taigent validate|plan|apply` (as `Bash(...)` and, for Claude Code's
Windows PowerShell tool, `PowerShell(...)` rules) and Taiga MCP read tools. They grant, not restrict: the gate
before `apply --yes` is the skill's explicit confirmation step. Codex's skill docs do not document
`allowed-tools`; there, approvals come from `.codex/config.toml` and the sandbox.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, `apply`/`bootstrap` with changes but no `--yes`, `skills` outside a repository root |
| 3 | `plan` or `--dry-run` found changes; `skills check` found differing copies |
| 4 | Manifest invalid or missing; Taiga was not contacted |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, unknown project, version conflict, custom attribute name not defined on the project; bootstrap refusals (not admin, unknown role/template, slug mismatch) |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`) |
| Manifest | `src/manifest/` | `loadManifests`/`MANIFESTS` registry (`manifests.ts`), `loadBacklog`, `loadDocs`, conventions rules (`conventions.ts`), `readManifestYaml`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`, PATCH with `version`, `getAttributeValues`/`updateAttributeValues`), `TaigaError`, `TaigaConflictError` |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote)` → operations + orphans, `srcTag(key)`, `ATTRIBUTE_ITEM_TYPE` |
| Executor | `src/executor.ts` | `executePlan(plan, client, statePath, customAttributes)`, `ApplyConflictError` (carries `key`) |
| Bootstrap | `src/bootstrap.ts`, `src/manifest/project.ts` | `loadProject`; pure `planBootstrap(manifest, remote)`, `executeBootstrap(plan, project, client, statePath)` |
| Upload | `src/upload.ts` | `planUpload(docs, backlog, project, client, cwd)` (reads Taiga, hashes files), `executeUpload(plan, client, cwd)`, `UploadTooLargeError` (carries `file`) |
| Skills | `src/skills.ts` | `compareSkills(root)`, `syncSkills(root)`: `.agents/skills/taiga-*` → `.claude/skills/taiga-*` |

Adding a manifest kind: write `load<Kind>(path, context)` that reads with `readManifestYaml`, reports every
problem through an `issue(path, rule, message)` sink (reusing the `check*` functions of `conventions.ts`) and
throws one `ManifestError`; then add its type to `Manifests` and an entry to `MANIFESTS` in `manifests.ts`, in
dependency order (`context.loaded` holds the manifests loaded before it, `context.invalid` the ones that failed).
`validate` and every command then pick it up. New rules go in `conventions.ts` and `docs/taiga/conventions.md`.

## Tests

`npm test` (Node's built-in runner) and `npm run typecheck`. Tests only go through the CLI seam:
`test/support/harness.ts` (`startHarness(t)`) spawns `bin/taigent.js` in a temp working directory against
`test/support/fake-taiga.ts` (`startFakeTaiga()`), an in-process fake of the Taiga API that validates
payloads like Taiga (and additionally rejects unknown fields). Extend the fake rather than mocking modules;
`fake.intercept({ method, path, status, body, after?, times? })` injects canned failures, and
`fake.onRequest({ method, path, run, times? })` runs a callback just before a request is handled (e.g.
`fake.editItem(story, { subject })` to simulate a concurrent edit). The fake implements Taiga's OCC: PATCH needs
`version`, and a stale version fails only when the same fields changed meanwhile. Seed data with `addEpic`,
`addUserStory`, `addTask`, `addEpicRelatedUserStory`; assert on `fake.state.{epics,userStories,tasks,epicRelatedUserStories}`.
Bootstrap fixtures: `fake.addUser`, `fake.addProject({ admins, is_private, modules, tagsColors })`,
`fake.addCustomAttribute`, `fake.addMembership`, `fake.addWikiPage`; `fake.state.templates` holds `scrum` (id 1)
and `kanban` (id 2) with Epics off; `fake.settings.projectSlugPrefix = true` mimics DEFAULT_PROJECT_SLUG_PREFIX.
Upload fixtures: `fake.addAttachment({ project, objectType: "epics" | "userstories" | "tasks" | "wiki", object_id, name,
content })` and `fake.editWikiPage(page, { content })` (bumps `version` for OCC); assert on `fake.state.attachments`
(with the stored `content` bytes). The fake parses `multipart/form-data` with Node's own parser (`Response#formData`),
computes `size`/`sha1` from the bytes like taiga-back, rejects unknown form fields, and records the body of a multipart
request as a `MultipartForm { fields, files }`. `fake.settings.maxBodyBytes = n` makes it answer any larger request body
with nginx's HTML 413 page, like Taiga's reverse proxy (`client_max_body_size`).
Custom attribute values: every epic/story/task gets an empty values object (version 1) on creation, served at
`/{epics,userstories,tasks}/custom-attributes-values/{id}` (keys must be ids of the project's attributes of that type,
PATCH replaces the object and needs its own `version`); `fake.editAttributeValues(itemType, itemId, values)` sets them
like a user would; assert on `fake.state.customAttributeValues` (`{ itemType, item, version, attributes_values }`).

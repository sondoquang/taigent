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
| `TAIGA_USERNAME`, `TAIGA_PASSWORD` | Login (`POST /auth`, type `normal`) |
| `TAIGENT_MANIFESTS_DIR` | Manifests root, default `./taiga` (relative to the working directory) |

Credentials are never printed.

## Manifest layout

One directory per Taiga project, named by its slug, committed to git:

```
taiga/<slug>/
  backlog.yaml   # desired epics (→ stories → tasks in later versions)
  state.json     # written by apply: key → Taiga id/ref/version (commit it)
```

`backlog.yaml`:

```yaml
epics:
  - key: AUTH            # required, unique, uppercase letters/digits/dashes
    subject: Authentication
    description: Users can sign in.   # optional
    tags: [type:feature, area:auth]   # optional
```

Unknown fields are rejected.

## Identity and state

Every item created on Taiga gets the tag `src:<key>` (lowercase, because Taiga lowercases tags). That tag
is the source of truth: plan/apply read the project's items back and match them by tag, so a deleted or
stale `state.json` never causes duplicates. `state.json` is a cache, rewritten by every `apply --yes`:

```json
{
  "project": { "id": 7, "slug": "test" },
  "items": { "AUTH": { "type": "epic", "id": 12, "ref": 3, "version": 1 } }
}
```

## Commands

Common options: `--project <slug>` (required), `--json` (machine-readable stdout), `--yes`, `--dry-run`, `-h/--help`.
`--dry-run` lists the operations a writing command (`bootstrap`, `apply`) would run and writes nothing, not even
`state.json`; it exits 3 when there are changes, 0 otherwise (`apply --dry-run` is the same as `plan`).

- `taigent plan --project <slug> [--json]`: reads Taiga, prints the operations `apply` would run. Never writes.
- `taigent apply --project <slug> --yes [--json]`: runs the plan, creating missing items in order and writing
  `state.json` after each created item (a failed run resumes where it stopped). Without `--yes` it prints the
  plan, writes nothing (not even `state.json`) and exits 2 when there are changes.

`plan --json` prints a `Plan`:

```json
{
  "project": { "id": 7, "slug": "test" },
  "changes": true,
  "summary": { "create": 1, "skip": 1 },
  "operations": [
    { "action": "create", "type": "epic", "key": "AUTH",
      "fields": { "subject": "Authentication", "description": "", "tags": ["type:feature", "src:auth"] } },
    { "action": "skip", "type": "epic", "key": "BILLING", "id": 12, "ref": 3, "version": 1 }
  ]
}
```

`apply --yes --json` prints an `ApplyReport`: `{ project, operations: [{ action, type, key, id, ref, result }],
summary: { created, unchanged } }`.

Errors print `taigent: <message>` on stderr; with `--json`, stdout also gets
`{ "error": { "kind": "usage" | "validation" | "taiga", "message", "issues"?, "status"? } }`.
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].key` / `key-unique`.

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

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, `apply`/`bootstrap` with changes but no `--yes` |
| 3 | `plan` or `--dry-run` found changes |
| 4 | Manifest invalid or missing; Taiga was not contacted |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, unknown project; bootstrap refusals (not admin, unknown role/template, slug mismatch) |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`) |
| Manifest | `src/manifest/` | `loadBacklog`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`), `TaigaError` |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote)`, `srcTag(key)` |
| Executor | `src/executor.ts` | `executePlan(plan, client, statePath)` |
| Bootstrap | `src/bootstrap.ts`, `src/manifest/project.ts` | `loadProject`; pure `planBootstrap(manifest, remote)`, `executeBootstrap(plan, project, client, statePath)` |

## Tests

`npm test` (Node's built-in runner) and `npm run typecheck`. Tests only go through the CLI seam:
`test/support/harness.ts` (`startHarness(t)`) spawns `bin/taigent.js` in a temp working directory against
`test/support/fake-taiga.ts` (`startFakeTaiga()`), an in-process fake of the Taiga API that validates
payloads like Taiga (and additionally rejects unknown fields). Extend the fake rather than mocking modules;
`fake.intercept({ method, path, status, body, after?, times? })` injects canned failures.
Bootstrap fixtures: `fake.addUser`, `fake.addProject({ admins, is_private, modules, tagsColors })`,
`fake.addCustomAttribute`, `fake.addMembership`, `fake.addWikiPage`; `fake.state.templates` holds `scrum` (id 1)
and `kanban` (id 2) with Epics off; `fake.settings.projectSlugPrefix = true` mimics DEFAULT_PROJECT_SLUG_PREFIX.

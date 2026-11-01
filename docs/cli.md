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
- **Orphans**: items carrying a `src:` tag whose key is no longer in the manifest are listed by `plan` and never
  deleted. They are not changes (they do not make `plan` exit 3).

## Commands

Common options: `--project <slug>` (required), `--json` (machine-readable stdout), `--yes`, `-h/--help`.

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

`apply --yes --json` prints an `ApplyReport`: `{ project, operations: [{ action, type, key, id, ref, epic?, result }],
summary: { created, updated, linked, unchanged } }`; `result` is `created`, `updated`, `linked` or `unchanged`, and
`epic` (the epic key) is set on `link` operations, whose `id`/`ref` are the story's.

Errors print `taigent: <message>` on stderr; with `--json`, stdout also gets
`{ "error": { "kind": "usage" | "validation" | "taiga" | "conflict", "message", "issues"?, "status"?, "key"? } }`.
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].stories[0].key` / `key-unique`.
`conflict` means Taiga refused an update because the item changed on Taiga after apply read it (OCC); `key`
names the item, nothing was overwritten, and re-running `plan` shows the new state.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, `apply` with changes but no `--yes` |
| 3 | `plan` found changes |
| 4 | Manifest invalid or missing; Taiga was not contacted |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, unknown project, version conflict |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`) |
| Manifest | `src/manifest/` | `loadBacklog`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`, PATCH with `version`), `TaigaError`, `TaigaConflictError` |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote)` → operations + orphans, `srcTag(key)` |
| Executor | `src/executor.ts` | `executePlan(plan, client, statePath)`, `ApplyConflictError` (carries `key`) |

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

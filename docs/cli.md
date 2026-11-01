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
  backlog.yaml   # desired epics (→ stories → tasks in later versions)
  docs.yaml      # wiki pages + attachments (optional)
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

Unknown fields are rejected. Names, tags, keys, wiki slugs and attachment names follow
`docs/taiga/conventions.md`; each rule there has the `rule` id that validation errors report.

`docs.yaml` (paths are relative to the directory of `docs.yaml`):

```yaml
wiki:
  - slug: spec-auth                  # kebab-case, unique
    file: pages/spec-auth.md         # Markdown, must exist
attachments:
  - target: AUTH-LOGIN               # a backlog key, or wiki:<slug> (a wiki page above, or wiki:home)
    file: files/auth-login-flow.pdf  # must exist; its name is the attachment name on Taiga
    description: Login flow          # optional
```

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

Common options: `--project <slug>` (required except for `validate`), `--json` (machine-readable stdout), `--yes`,
`-h/--help`.

- `taigent validate [--project <slug>] [--json]`: checks every manifest present in `taiga/<slug>/` (all project
  directories without `--project`) against the schema and the conventions. Offline: needs no `TAIGA_*` variable
  and never contacts Taiga. Exit 0 when valid, 4 otherwise. `--json` prints
  `{ "valid": true, "projects": [{ "slug", "files": ["taiga/demo/backlog.yaml", …] }] }`.
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
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].key` / `key-unique`; the text
form is `<file>: <path>: <message> [<rule>]`. `plan`/`apply` validate the whole project directory the same way
(and require `backlog.yaml`) before contacting Taiga.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, `apply` with changes but no `--yes` |
| 3 | `plan` found changes |
| 4 | Manifest invalid or missing; Taiga was not contacted |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, unknown project |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`) |
| Manifest | `src/manifest/` | `loadManifests`/`MANIFESTS` registry (`manifests.ts`), `loadBacklog`, `loadDocs`, conventions rules (`conventions.ts`), `readManifestYaml`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`), `TaigaError` |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote)`, `srcTag(key)` |
| Executor | `src/executor.ts` | `executePlan(plan, client, statePath)` |

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
`fake.intercept({ method, path, status, body, after?, times? })` injects canned failures.

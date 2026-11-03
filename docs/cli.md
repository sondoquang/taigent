# `taigent` CLI

Headless CLI that applies declarative manifests to Taiga through its REST API, and edits or reports on the user's
own tickets. Agents and skills call it through the shell; it is the only path for writes to Taiga (MCP stays
read-only).

## Running

Requires Node.js 24+. In the repository it runs the TypeScript sources directly; installed as a package it runs
the build in `dist/` (`npm run build`, run by `prepare` on install; see [Using the skills in another project](#using-the-skills-in-another-project)).

```sh
npm install
npm run taigent -- plan --project my-project      # works in PowerShell and POSIX shells
npx taigent plan --project my-project             # same, via the package bin
```

## Credentials and environment

Every command that talks to Taiga uses, in this order:

1. `TAIGA_TOKEN` and/or `TAIGA_USERNAME` + `TAIGA_PASSWORD`, when set (with `TAIGA_API_URL`): for CI and machines
   without an OS credential store;
2. else the **stored login** of [`taigent login`](#login-and-the-mcp-server). A `TAIGA_API_URL` that is set must then
   be the stored login's URL (exit 2 otherwise);
3. else exit 2, saying `not logged in to Taiga` and how to log in.

A variable not set (or empty) in the environment is read from `.env` in the working directory, when there is one
(`KEY=value` lines, the format of `.env.example`); the environment wins. Keep `.env` out of git. `taigent mcp` reads
the same variables, so `.env` reaches the Taiga MCP server too.

| Variable | Meaning |
|---|---|
| `TAIGA_API_URL` | API base URL including `/api/v1`, e.g. `https://taiga.example.com/api/v1` |
| `TAIGA_USERNAME`, `TAIGA_PASSWORD` | Login (`POST /auth`, type `normal`); also the fallback when `TAIGA_TOKEN` is rejected |
| `TAIGA_TOKEN` | Access token used instead of username/password (sent as `Authorization: Bearer`) |
| `TAIGENT_MANIFESTS_DIR` | Manifests root, default `./taiga` (relative to the working directory) |
| `TAIGENT_RETRY_UNIT_MS` | Milliseconds per second of 429 backoff, default `1000` (tests set it low) |
| `TAIGENT_CREDENTIAL_STORE` | Where `login` keeps its token: `keyring` (default: Windows Credential Manager, macOS Keychain, Linux Secret Service) or `file` (`credentials.json` in the config directory, mode 0600, plain JSON: for machines without a credential store) |
| `TAIGENT_CONFIG_DIR` | Config directory of the stored login, default `%APPDATA%\taigent` (Windows), `~/Library/Application Support/taigent` (macOS), `$XDG_CONFIG_HOME/taigent` or `~/.config/taigent` (Linux) |
| `TAIGENT_READ_ONLY` | `1`: refuse every write to Taiga, see [Read-only runs](#read-only-runs). Taigent Desktop sets it on its headless skill runs |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | [`notify`](#notify): the bot and the chat to send to; default: the Claude Code Telegram plugin's own (see [Notify](#notify)) |
| `TELEGRAM_STATE_DIR` | `notify`: the Telegram plugin's state directory, default `<CLAUDE_CONFIG_DIR or ~/.claude>/channels/telegram` (the plugin's own default) |
| `TAIGENT_TELEGRAM_API_URL` | `notify`: Bot API base URL, default `https://api.telegram.org` (tests point it at a stand-in) |

Authentication and retries (all in `TaigaClient`, so every command gets them):

- **401:** the client renews the access token once and retries the request: `POST /auth/refresh` with the
  refresh token from the login, else (refresh rejected, or `TAIGA_TOKEN` without a refresh token) a new
  login with `TAIGA_USERNAME`/`TAIGA_PASSWORD` when set; with the stored login, the renewal of
  [Login and the MCP server](#login-and-the-mcp-server). If that is impossible or the retry gets 401 again,
  the run fails (exit 5) naming the URL and what to fix (`TAIGA_TOKEN`, `TAIGA_USERNAME and TAIGA_PASSWORD`, or
  `npx taigent login`).
- **429:** up to 5 retries per request, waiting `Retry-After` (seconds or HTTP date) when Taiga sends it,
  else 1, 2, 4, 8, 16 units; one wait is capped at 60 units (unit = `TAIGENT_RETRY_UNIT_MS`).
- A `TAIGA_API_URL` with credentials in it (`https://user:password@…`) is a configuration error (exit 2): put them
  in `TAIGA_USERNAME`/`TAIGA_PASSWORD` instead (the message never repeats the URL). So is
  `TAIGA_TOKEN`/`TAIGA_USERNAME`+`TAIGA_PASSWORD` without `TAIGA_API_URL`.

Credentials and tokens are never printed: Taiga error bodies are included in messages, but `TAIGA_PASSWORD`,
`TAIGA_TOKEN`, the password of a `user:password@` in `TAIGA_API_URL`, the password typed at `login`, the stored
tokens and every access/refresh token the client obtains are replaced by `[redacted]` in everything the CLI writes:
stdout, stderr, `--json` and the stack trace of an internal error (exit 1). One `Secrets` registry
(`src/secrets.ts`) is shared by the CLI, the client, the stored login and the MCP proxy;
`test/resilience.test.ts` checks every output path, including internal errors and URL credentials.

## Manifest layout

One directory per Taiga project, named by its slug, committed to git:

```
taiga/<slug>/
  backlog.yaml   # desired epics → stories → tasks, and issues
  docs.yaml      # wiki pages + attachments (optional)
  review.yaml    # verdicts and comments of the BA/PO review, see Review (optional; commit it)
  state.json     # written by apply: key → Taiga id/ref/version and baseline (commit it)
  snapshot.json  # written by snapshot: the backlog as Taiga holds it (git-ignored, never commit it)
```

`backlog.yaml`:

```yaml
epics:
  - key: AUTH            # required, unique across epics, stories, tasks and issues; uppercase letters/digits/dashes
    ref: 3               # optional: the Taiga ref of the hand-made item this backlog item adopts (see Adopt)
    subject: Authentication
    description: Users can sign in.   # optional
    tags: [type:feature, area:auth]   # optional
    stories:                          # optional; each story is linked to this epic
      - key: AUTH-LOGIN
        subject: Sign in to reach my projects        # the user story Summary
        use_case:                                    # with scenarios: Mike Cohn use case, all three parts required
          as_a: returning team member
          i_want_to: sign in with my password
          so_that: I land on my project list
        description: Single sign-on comes later.     # optional context
        scenarios:                                   # with use_case: one or more Gherkin scenarios
          - scenario: Wrong password
            given:                                   # one or more
              - I have an account
              - I am on the sign-in page
            when: I submit a wrong password          # exactly one string
            then: I see "Invalid credentials"        # exactly one string
        spec: docs/specs/auth.md                     # optional link/path to the spec
        tags: [type:feature]
        custom_attributes:                           # optional, on epics, stories, tasks and issues
          Due note: before launch                    # attribute name (as on Taiga) → string, number or boolean
        tasks:                                       # optional; created under this story
          - key: AUTH-LOGIN-API
            subject: Login endpoint
            description: POST /login returns a session.   # optional
            tags: []                                      # optional
issues:                                                   # optional; bugs, questions, enhancements outside the epic tree
  - key: BUG-LONG-PASSWORD
    subject: Login fails with a 100-character password
    description: |                                        # optional; written to Taiga as is
      ## Steps to reproduce
      1. Open the sign-in page
    type: Bug                                             # required: names of the project's values on Taiga
    severity: Critical
    priority: High
    tags: [type:bug, area:auth]                           # optional
    custom_attributes:                                    # optional; the project's issue attributes
      Found in: 1.2.0
```

Unknown fields are rejected, also inside `use_case` and inside a scenario (there is no status, assignee, sprint or
points field: those belong to the people doing the work).

`ref`, on an epic, story, task or issue, is the Taiga ref of the hand-made item the backlog item adopts
([Adopt](#adopt) writes it). It is a positive integer (else `type`) and names one backlog item only (rule
`ref-unique`). It stays after apply, as an assertion that the item tagged `src:<key>` is that ref (rule `item-ref`,
see [Reconciliation](#reconciliation)).

An issue has no parent and no link. `type`, `severity` and `priority` are required non-empty strings (missing or
empty: `required`, another type: `type`); offline, `validate` checks only that shape. They name the project's own
issue types, severities and priorities on Taiga (the default templates have `Bug`/`Question`/`Enhancement`,
`Wishlist`/`Minor`/`Normal`/`Important`/`Critical` and `Low`/`Normal`/`High`); `plan` and `apply` match them by exact
name after reading Taiga (see [Reconciliation](#reconciliation)). The description is written as is: the "Steps to
reproduce / Expected / Actual" template is a convention (`docs/taiga/conventions.md` §6.4), not a rule.

A story comes in one of two formats ([ADR 0001](adr/0001-user-story-format-mike-cohn-gherkin.md)): the **user story format**, `use_case` + `scenarios` (Mike Cohn +
Gherkin, labels stay in English), and the **legacy format**, free `description` + `acceptance_criteria`, kept only
for stories already on Taiga (tagged `src:<key>`, or adopted by `ref`, see [Adopt](#adopt)):

```yaml
      - key: AUTH-LOGOUT
        subject: User can log out
        description: As a user I want to log out.    # optional
        acceptance_criteria:                         # optional list of non-empty strings
          - Session ends
```

`description`, `spec`, `tags`, `custom_attributes` and `tasks` work with both. Validation (offline, so in `validate`,
`plan` and `apply`) checks the shape of the user story format: `use_case` is a mapping with non-empty `as_a`,
`i_want_to` and `so_that`; `scenarios` is a non-empty list of mappings, each with a non-empty `scenario`, a `given`
list of at least one non-empty string, and non-empty `when` and `then` strings (a list is a `type` error). Missing
or empty values are `required`, wrong types `type`, unknown fields `known-field`. Rule **`story-format`** reports a
story with `use_case` but no `scenarios` (or the reverse), and a story mixing `acceptance_criteria` with `use_case`
or `scenarios`. Whether a story is new is only known on Taiga, so `validate` accepts the legacy format; `plan` and
`apply` refuse to create it (see [Reconciliation](#reconciliation)).

A story's Taiga description is rendered from a template; its parts are joined by one blank line and empty parts are
left out. User story format:

```
- **As a** <as_a>
- **I want to** <i_want_to>
- **so that** <so_that>

<description>

## Acceptance criteria

- [ ] **Scenario:** <scenario>
  - **Given:** <given[0]>
  - **and Given:** <given[1..]>
  - **When:** <when>
  - **Then:** <then>
- [ ] **Scenario:** <next scenario>
  ...

Spec: <spec>
```

Legacy format, unchanged byte for byte so stories already on Taiga stay unchanged:

```
<description>

## Acceptance criteria

- [ ] <criterion>

Spec: <spec>
```

A legacy story with neither `acceptance_criteria` nor `spec` (a free-text story [adopted](#adopt) from Taiga) renders
exactly its `description`, nothing trimmed: line endings, trailing whitespace and trailing blank lines stay.

Names, tags, keys, wiki slugs and attachment names follow `docs/taiga/conventions.md`; each rule there has the
`rule` id that validation errors report. Keys are unique across epics, stories, tasks and issues.

`docs.yaml` (paths are relative to the directory of `docs.yaml` and may point outside it, so documents are referenced
where they already are, e.g. `../../docs/specs/auth.md`):

```yaml
wiki:
  - slug: spec-auth                  # kebab-case, unique
    file: pages/spec-auth.md         # Markdown, must exist
attachments:
  - target: AUTH-LOGIN               # an epic, story or task key (not an issue), or wiki:<slug> (a wiki page above, or wiki:home)
    file: files/auth-login-flow.pdf  # must exist; its name is the attachment name on Taiga
    description: Login flow          # optional
```

## Identity and state

Every item created on Taiga gets the tag `src:<key>` (lowercase, because Taiga lowercases tags). That tag
is the source of truth: plan/apply read the project's epics, stories, tasks and issues back and match them by tag,
so a deleted or stale `state.json` never causes duplicates. `state.json` is rewritten by every `apply --yes`
(`type` is `epic`, `story`, `task` or `issue`):

```json
{
  "project": { "id": 7, "slug": "test" },
  "items": {
    "AUTH": {
      "type": "epic", "id": 12, "ref": 3, "version": 1,
      "baseline": { "subject": "Authentication", "description": "Users can sign in.", "tags": ["type:feature", "area:auth"], "custom_attributes": {} }
    }
  }
}
```

### Baseline and remote edits

An item's `baseline` holds the managed values taigent last wrote or accepted for it (`ManagedValues` of
`src/managed.ts`): `subject`, `description` (a story's as rendered), `tags` (lowercased, `type:`/`area:` only; the
`src:` tag is the identity), `custom_attributes` (the values of the attributes the manifest declares), a story's
`epics` (keys of the taigent epics it is linked to), a task's `story` (its story's key, or `null`) and an issue's
`type`, `severity` and `priority` names. Status, assignee, sprint, points, order and tags without a prefix are never
part of it, so changing them on Taiga never blocks anything. `apply --yes` writes the baseline after each create,
update, adopt and link, and for each skipped item whose manifest equals Taiga: that is how a `state.json` from before
baselines is migrated. A baseline counts only for the Taiga item of the same type and id.

`plan` compares each item tagged `src:<key>` three ways, B = baseline, T = Taiga, M = manifest. An item adopted by
`ref` (no `src:<key>` tag yet) is never blocked: its `adopt` operation records its first baseline, and from the next
plan on it is compared like any tagged item.

| B | T vs B | M vs B | M vs T | Result |
|---|---|---|---|---|
| present | same | same | | skip |
| present | same | changed | | update |
| present | changed | same | | blocked: `remote-edit` |
| present | changed | changed | same | skip (apply refreshes the baseline) |
| present | changed | changed | different | blocked: `conflict` (all three versions) |
| missing | | | same | skip (apply records the baseline) |
| missing | | | different | blocked: `unknown` (Taiga's and the manifest's version) |

"M vs B" and "M vs T" compare like an update does (tags and epic links additive: dropping one from the manifest is
no change). "T vs B" compares prefixed tags as sets (adding or removing one on Taiga is a remote edit), epic links of
the manifest's epic only, and declared custom attributes only (a value never recorded counts as unset). A blocked
item gets no operation; `plan`, `apply --dry-run` and `apply` without `--yes` print the plan with its `blocked` list and
exit 6, and `apply --yes` refuses with exit 6 (kind `blocked`) before any write, leaving Taiga and `state.json`
untouched. Settle each one in `backlog.yaml` (take Taiga's values, or merge both), then plan again. The first run
after upgrading shows items applied earlier that differ from Taiga as `unknown`.

## Reconciliation

- **Create**: missing items, in dependency order: each epic, then each of its stories, the story's epic link,
  and the story's tasks (created with `user_story` = the parent story). A new story must use the user story format:
  after reading Taiga, `plan` and `apply` exit 4 (kind `validation`) if any story to create lacks `use_case` and
  `scenarios`, with one issue `{file, path: epics[i].stories[j], rule: story-format}` per such story, and write
  nothing. A story is new when no story on Taiga carries its `src:<key>` tag and its `ref` (if any) adopts none;
  `state.json` plays no part. Adopts, updates and skips of stories in the legacy format already on Taiga are
  unaffected: their template renders byte for byte as before. Issues come after the epic tree, in manifest order;
  they have no parent and no link.
- **Adopt**: a backlog item with a `ref` and no item tagged `src:<key>` takes over the untagged item of its type with
  that ref: an `adopt` operation, whose `changes.tags` adds `src:<key>` (plus the manifest's missing tags) and whose
  other changes are content updates, as in an update. Apply PATCHes it with the item's `version`, like an update;
  right after [`taigent adopt`](#adopt) the content matches and only the tag is written. After reading Taiga, `plan`
  and `apply` exit 4 (kind `validation`) with one issue `{file, path: <item>.ref, rule: item-ref}` per backlog item
  whose `ref` does not match: the item tagged `src:<key>` has another ref, or the ref names no item, an item of
  another type, or an item tagged with another key. They write nothing.
- **Issue values**: after reading Taiga, `plan` and `apply` resolve each issue's `type`, `severity` and `priority` to
  the ids of the project's values with that exact name (`GET /issue-types`, `/severities`, `/priorities?project=`,
  read only when the backlog has issues). A name the project does not define makes them exit 4 (kind `validation`),
  with one issue `{file, path: issues[i].<field>, rule: issue-value}` per unknown name (its message lists the names
  that exist), and write nothing.
- **Link**: a story is linked to its epic with `POST /epics/{id}/related_userstories`, after
  `GET /epics/{id}/related_userstories` (read for every epic with a `src:` tag) shows the link is missing. Existing
  links are never removed.
- **Update**: apply manages only `subject`, `description` and `tags`, a task's parent story, and an issue's `type`,
  `severity` and `priority`. When they differ from the manifest it PATCHes them with the item's current `version`
  (OCC). Tags are only added: tags people put on Taiga stay, and removing a tag from the manifest does not remove it
  from Taiga. Status, assignee, sprint, points and ordering are never sent: a new issue gets the project's default
  status on Taiga, and the status, assignee and sprint people set on it stay.
- **Moves**: a task placed under another story in the manifest is an `update` with `changes.parent`; apply PATCHes
  `{user_story, version}` (taiga-back then puts the task in that story's sprint, `TaskViewSet.pre_save`). A story
  placed under another epic gets a `link` to the new epic; a story can belong to several epics on Taiga
  (`RelatedUserStory` is unique per epic and story only), so the link to the old epic stays and `plan` lists it under
  `staleLinks` (not a change, never removed: unlink it on Taiga by hand if obsolete). Only links to epics with a `src:`
  tag are reported; links people made to their own epics are left alone.
- **Custom attribute values**: an item's `custom_attributes` are matched to the project's attributes of that item
  type by exact name (`GET /projects/by_slug` lists them; bootstrap creates them from `project.yaml`). `plan` reads
  `GET /{epics,userstories,tasks,issues}/custom-attributes-values/{id}` of existing items that declare values and lists the
  declared values that differ. `apply` writes them with `PATCH …/custom-attributes-values/{id}
  {attributes_values, version}` (keys are attribute ids as strings; values objects have their own `version`, read
  by plan for existing items, so a value changed on Taiga meanwhile is a `conflict`). Taiga replaces the whole
  object, so apply sends the current values plus the manifest's: values of undeclared attributes stay, and removing
  a value from the manifest does not clear it on Taiga. New items get their values right after creation.
  An attribute name the project does not define fails `plan`/`apply` before any write, with exit 5 (the manifest is
  valid; the project lacks the attribute, so it is not exit 4), listing every unknown name with its key and the
  names that exist.
- **Orphans**: items carrying a `src:` tag whose key is no longer in the manifest are listed by `plan` and never
  deleted. They are not changes (they do not make `plan` exit 3).
- **Hand-made children**: stories linked on Taiga to a manifest epic (links are read for every epic tagged `src:` or
  adopted by `ref`), and tasks in a manifest story, that carry no `src:` tag and no backlog item adopts, are listed
  by `plan` under `handMadeChildren`, not as stale links. Their content and links are never touched; they are not
  changes.

## Commands

Common options: `--project <slug>` (required except for `init`, `validate`, `tickets`, `projects`, `notify`, `skills`, `login`, `logout`, `whoami` and `mcp`), `--json` (machine-readable stdout),
`--yes`, `--dry-run`, `-h/--help`. `--dry-run` lists the operations a writing command (`bootstrap`, `apply`, `upload`)
would run and writes nothing, not even `state.json`; it exits 3 when there are changes, 0 otherwise (`apply --dry-run`
is the same as `plan`; `init --dry-run` lists the files it would write). Without `--yes` or `--dry-run`, a writing
command prints the same operations, writes nothing and exits 2 when there are changes.

- `taigent init [--dry-run] [--json]`: installs Taigent into the repository at the working directory, from the
  running taigent: the Taigent skills, the Taiga MCP server entries, the headless kit and the pinned `taigent`
  devDependency. Offline; writes at once (no `--yes`). See
  [Using the skills in another project](#using-the-skills-in-another-project).
- `taigent validate [--project <slug>] [--json]`: checks every manifest present in `taiga/<slug>/` (all project
  directories without `--project`) against the schema and the conventions, and `review.yaml` when present (see
  [Review](#review)). Offline: needs no `TAIGA_*` variable and never contacts Taiga. Exit 0 when valid, 4 otherwise.
  `--json` prints `{ "valid": true, "projects": [{ "slug", "files": ["taiga/demo/backlog.yaml", …] }] }`.
- `taigent preview --project <slug> [--out <file>] [--json]`: the backlog as `apply` would write it, with its
  review; offline. See [Review](#review).
- `taigent plan --project <slug> [--json]`: reads Taiga, prints the operations `apply` would run, the blocked items
  (see [Baseline and remote edits](#baseline-and-remote-edits); exit 6 when any) and the orphans. Never writes.
- `taigent apply --project <slug> --yes [--json]`: runs the plan in order, writing `state.json` after each
  write to Taiga (a failed run resumes where it stopped). It stops at the first error, naming the operation and
  key. Without `--yes` it prints the plan, writes nothing (not even `state.json`) and exits 2 when there are
  changes. While any item is blocked it writes nothing and exits 6.
- `taigent adopt --project <slug> --ref <n> --key <KEY> [--epic <KEY> | --story <KEY>] [--json]`: writes the
  hand-made epic, user story (under manifest epic `--epic`), task (under manifest story `--story`) or issue `#<n>`
  into `backlog.yaml` as backlog item `<KEY>`; reads Taiga, writes the manifest only. See [Adopt](#adopt).
- `taigent tickets`, `taigent status`, `taigent comment`, `taigent notify`: see [Tickets](#tickets),
  [Status and comment](#status-and-comment) and [Notify](#notify).
- `taigent projects [--project <slug>] [--json]`: the Taiga projects you are a member of, or the issue values of one
  project; read-only. See [Projects](#projects).
- `taigent report --project <slug> [--json]`: the project's progress by sprint and by epic, and its stories in no
  sprint; read-only. See [Report](#report).
- `taigent snapshot --project <slug> [--json]`: writes every epic and every open story, task and issue of the
  project, hand-made ones too, to `taiga/<slug>/snapshot.json`; read-only on Taiga. See [Snapshot](#snapshot).
- `taigent login [--application <id>]`, `taigent logout`, `taigent whoami [--json]`, `taigent mcp`: see
  [Login and the MCP server](#login-and-the-mcp-server).

`plan --json` prints a `Plan`; operations are `create`, `update`, `adopt`, `link` or `skip`:

```json
{
  "project": { "id": 7, "slug": "test" },
  "changes": true,
  "summary": { "create": 2, "update": 1, "adopt": 1, "link": 1, "skip": 1 },
  "operations": [
    { "action": "skip", "type": "epic", "key": "AUTH", "id": 12, "ref": 3, "version": 1 },
    { "action": "create", "type": "story", "key": "AUTH-LOGIN", "parent": "AUTH",
      "fields": { "subject": "User can log in", "description": "…", "tags": ["type:feature", "src:auth-login"] } },
    { "action": "link", "type": "story", "key": "AUTH-LOGIN", "epic": "AUTH" },
    { "action": "create", "type": "task", "key": "AUTH-LOGIN-API", "parent": "AUTH-LOGIN",
      "fields": { "subject": "Login endpoint", "description": "", "tags": ["src:auth-login-api"] } },
    { "action": "update", "type": "story", "key": "AUTH-LOGOUT", "id": 15, "ref": 6, "version": 4,
      "changes": { "subject": { "from": "Log out", "to": "User can log out" },
                   "tags": { "from": ["src:auth-logout", "urgent"], "to": ["src:auth-logout", "urgent", "type:feature"] } } },
    { "action": "adopt", "type": "epic", "key": "PAY", "id": 30, "ref": 11, "version": 2,
      "changes": { "tags": { "from": ["area:payments", "frontend"], "to": ["area:payments", "frontend", "src:pay"] } } }
  ],
  "orphans": [ { "type": "task", "key": "AUTH-OLD", "id": 20, "ref": 9, "subject": "Old task" } ],
  "staleLinks": [ { "key": "AUTH-LOGOUT", "id": 15, "ref": 6, "epic": "ACCOUNT", "epicId": 13, "epicRef": 4 } ],
  "blocked": [
    { "kind": "remote-edit", "type": "epic", "key": "BILLING", "id": 14, "ref": 5,
      "fields": { "subject": { "baseline": "Billing", "taiga": "Payments", "manifest": "Billing" } } }
  ],
  "handMadeChildren": [ { "type": "story", "id": 31, "ref": 12, "subject": "Pay by card", "parent": "PAY" } ]
}
```

`create.parent` is the epic key (story) or story key (task); issues have none. An issue's `create.fields` also hold the
ids of its `type`, `severity` and `priority`, and its `update.changes` may hold `type`, `severity` and `priority` as
`{ from: <id> | null, to: <id>, names: { from: "<name>" | null, to: "<name>" } }` (apply sends `to`; the text form
shows the names, e.g. `type (Question -> Enhancement)`). `update.changes` holds only the fields that differ; a
moved task has `changes.parent: { from: "<story key>" | null, to: "<story key>" }` (`null`: in no taigent story).
`staleLinks` lists stories still linked to a taigent epic other than their manifest epic (`epic`: that epic's key).
`blocked` lists the items plan leaves alone: `kind` is `remote-edit`, `conflict` or `unknown`; `fields` holds each
managed field that differs between any two versions, with its `baseline` (absent for `unknown`), `taiga` and
`manifest` values as in `state.json`'s baseline (e.g. `tags` are the prefixed tags, `epics` epic keys).
`adopt.changes` has the shape of `update.changes`, and always holds `tags`; an adopted item is never blocked (it has
no baseline yet: the adopt records its first). `handMadeChildren` lists the hand-made stories (`parent`: the manifest
epic's key) and tasks (`parent`: the manifest story's key) under backlog items.
Custom attribute values add `custom_attributes: { "<name>": value }` to `create`, and
`changes.custom_attributes: { from: { "<name>": value | null }, to: { "<name>": value }, version }` to `update`
(`null`: not set on Taiga; `version`: the values object's). An update of values alone does not PATCH the item.

`apply --yes --json` prints an `ApplyReport`: `{ project, operations: [{ action, type, key, id, ref, epic?, result }],
summary: { created, updated, adopted, linked, unchanged } }`; `result` is `created`, `updated`, `adopted`, `linked` or `unchanged`, and
`epic` (the epic key) is set on `link` operations, whose `id`/`ref` are the story's.

Errors print `taigent: <message>` on stderr; with `--json`, stdout also gets
`{ "error": { "kind": "usage" | "login" | "read-only" | "validation" | "taiga" | "conflict" | "blocked" | "telegram", "message", "issues"?, "status"?, "key"?, "blocked"? } }`
(`login`: no stored login, or `login` run without a terminal; `read-only`: a write refused under
[`TAIGENT_READ_ONLY`](#read-only-runs); `telegram`: the Bot API refused or could not be reached).
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].stories[0].key` / `key-unique`.
`conflict` means Taiga refused an update because the item changed on Taiga after apply read it (OCC); `key`
names the item, nothing was overwritten, and re-running `plan` shows the new state. `blocked` (exit 6) means
`apply --yes` refused because of blocked items, listed in `blocked` with the shape of the plan's; nothing was written.
The text form is `<file>: <path>: <message> [<rule>]`. `plan`/`apply` validate the whole project directory the
same way (and require `backlog.yaml`) before contacting Taiga; after reading Taiga they also refuse a `ref` that does
not match Taiga (rule `item-ref`), a story to create in the legacy format (rule `story-format`) and an issue value the
project does not define (rule `issue-value`), see [Reconciliation](#reconciliation), still before any write.

## Read-only runs

With `TAIGENT_READ_ONLY=1` (environment or `.env`), every command that would write to Taiga refuses before it
contacts Taiga, with exit 2 and `error.kind` `read-only` under `--json`: `apply --yes`, `upload --yes` and
`bootstrap --yes` (without `--dry-run`), `status` and `comment`. `validate`, `preview`, `plan`, every `--dry-run`, the
writing commands without `--yes` (they print the plan and exit 2 as usual) and the read-only commands still work.
Taigent Desktop sets it on its headless skill runs, so the agent's shell and every `npx taigent` it runs inherit it:
the guard does not depend on the agent following its prompt ([docs/headless.md](headless.md#taigent-desktop-buttons)).
Any other value, or none, changes nothing.

## Review

Before `apply`, the Business Analyst / Product Owner reviews the backlog the agent wrote: in Taigent Desktop
(`docs/desktop.md`) or with `taigent preview`. Verdicts and comments live in `taiga/<slug>/review.yaml`, committed
with the manifests; the agent answers the comments by editing the manifests (skill `taiga-plan-backlog`). The review
never writes to Taiga, and `plan`/`apply` ignore `review.yaml`: apply still needs the user's explicit approval
(`docs/taiga/conventions.md` §1).

`taigent preview --project <slug> [--out <file>] [--json]` reads `backlog.yaml` (required; the whole project
directory is validated like `plan`), `state.json` and `review.yaml`, offline (no `TAIGA_*` variable, no login). The
text form is one Markdown page: a summary table (epics, stories, tasks, issues, new / on Taiga, approved, changes
requested, not reviewed, stale, open comments), then each epic → story → task, then an **Issues** section with each
issue's type, severity and priority; every item with its tags, custom attributes, Taiga ref (from `state.json`),
review status and comments, and its description exactly as apply writes it (a story's includes its acceptance
criteria and spec link). `--json` prints the `Preview` object of `src/review.ts`
(`{ project: { slug, name? }, summary, epics: [{ …item, stories: [{ …item, format, spec, tasks }] }], issues: [{ …item,
values: { type, severity, priority } }] }`, `format` being `user-story` or `legacy`, `values` the names as in the
manifest,
each item `{ type, key, subject, description, tags, customAttributes, parent?, applied?: { id, ref }, digest,
review: { verdict?, stale, by?, at?, comments, openComments } }`; `summary` counts `epics`, `stories`, `tasks` and
`issues`, and the review states over all of them). `--out <file>` writes the page (or the JSON) to
that file instead and prints `Preview written to <file>` (`{ "out": "<file>" }` with `--json`). Exit 0; 4 when a
manifest or `review.yaml` is invalid.

`review.yaml`:

```yaml
items:
  AUTH-LOGIN:                      # a key of backlog.yaml
    verdict: approved              # approved | changes (optional)
    digest: 3f1c…                  # required with verdict: the item's digest when the verdict was given
    by: Lan                        # optional
    at: 2026-11-02T09:30:00Z       # optional, ISO 8601 date-time
    comments:                      # optional
      - id: c1                     # unique within the item (c1, c2, …)
        by: Lan
        at: 2026-11-02T09:31:00Z
        text: Thiếu tiêu chí khi khoá tài khoản.
        resolved: true             # default false; the agent sets it once the manifest addresses the comment
        reply: Đã thêm tiêu chí khoá 15 phút.   # optional, the agent's short answer
```

An item's **digest** is the SHA-256 of what apply writes for it: subject, description as written (a story's with
its acceptance criteria and spec), tags (lowercased, order-insensitive), custom attributes, parent key and, for an
issue, its type, severity and priority names. A verdict
whose digest differs from the item's current one is **stale**: the item changed after it was reviewed, so it counts
as stale, not as approved. Editing `review.yaml` never changes a digest, and the digest leaves the key out. Files are
written with sorted keys (`saveReview`); items with neither a verdict nor a comment are dropped.

Renaming or removing an item: `rekeyReviewFile(dir, { <old key>: <new key> | undefined })` moves the comments of a
renamed item to its new key and drops its verdict (a renamed item needs review again; Taigent Desktop runs it after a
form changes a key), and drops the entry of a removed item. `review.yaml` is rewritten only when a key it names
changed.

`validate` reports, besides the generic `type`, `required` and `known-field` rules: `key-format` and `key-reference`
for item keys (epics, stories, tasks and issues: `reviewKeys(backlog)`; a key the backlog does not declare, e.g.
after the item was removed or renamed: move or delete its
entry), `review-verdict` (a verdict other than `approved`/`changes`) and `review-comment-unique` (a duplicate
comment id within an item). `preview` itself tolerates unknown keys and lists them in `summary.unknownReviewKeys`.

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
custom_attributes:                  # optional, per item type: epic | story | task | issue (as in backlog.yaml and plans)
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
existing: true                      # optional, default false: a project made in Taiga before taigent (see below)
```

`existing: true` declares a Hand-made project that already exists on Taiga: the `project-name` and `project-slug`
rules do not apply (`name` must be non-empty, `slug` is the project's real Taiga slug, still equal to the directory
name), and bootstrap never creates it. When no visible project has the slug, bootstrap exits 5 before any write
(`--dry-run` too); otherwise it fills the gaps like for any existing project. Taigent Desktop's project form writes
the flag when it takes the project name from Taiga.

Steps, in order (each is `create`, `update` or `skip` in the plan):

| Step | Taiga call | Gap filled when |
|---|---|---|
| project | `POST /projects {name, description, creation_template, is_private}` | no project has the slug (`GET /projects/by_slug`) |
| modules | `PATCH /projects/{id} {is_<module>_activated: true}` | a listed module is off (templates ship with Epics off) |
| tag | `POST /projects/{id}/create_tag {tag, color}`; `edit_tag {from_tag, color}` | tag missing; tag exists (e.g. used by items) with another color |
| custom-attribute | `POST /{epic,userstory,task,issue}-custom-attributes {project, name, description, type}` (Taiga's names for epic, story, task, issue) | no attribute with that name |
| membership | `POST /memberships {project, role, username}` (role id looked up by name) | username not a member / e-mail not invited |
| wiki | `POST /wiki {project, slug: "home", content}` | `GET /wiki/by_slug` finds no `home` (an existing page is left alone) |

Refusals (exit 5, nothing written): `existing: true` but no visible project has the slug; the slug exists but `i_am_admin` is false (`status: 403`); the slug belongs to a
private project the user cannot see (`status: 403`); a member's role is not defined by the template/project; the
template is unknown. `GET /projects/by_slug` answers 404 both for a free slug and for a private project the user is not
a member of, so when it finds nothing bootstrap asks `GET /resolver?project=<slug>`, which taiga-back answers 403 for
an existing project the user cannot see and 404 for a free slug (`ResolverViewSet.list`: unfiltered lookup, then
`view_project`). Without that check Taiga would create a second project with a suffixed slug (`slugify_uniquely`:
`<slug>-1`, …). Taiga derives the slug itself (read-only on `POST /projects`, possibly prefixed with the owner
username, `DEFAULT_PROJECT_SLUG_PREFIX`): if the created slug still differs, bootstrap stops with exit 5 after
recording the real id/slug in `state.json`, and later runs refuse to create a second project.

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

## Projects

`taigent projects [--json]` lists the Taiga projects the user the CLI logs in as is a member of (`GET /users/me`, then
`GET /projects?member=<id>`: public projects they only see are left out), in Taiga's order, with whether they are its
admin (bootstrap needs it) and whether the repository holds its manifest directory, `<manifests root>/<slug>/`
(`TAIGENT_MANIFESTS_DIR`, default `./taiga`; an empty directory counts). `--json` prints
`{ "projects": [{ "id", "slug", "name", "admin", "manifest" }] }`.

`taigent projects --project <slug> [--json]` reads one project the user can see (exit 5 when there is none), the
names of its issue types, severities and priorities, in Taiga's order (`GET /issue-types`, `/severities`,
`/priorities`): the values an issue of `backlog.yaml` may name; and its user story statuses, in Taiga's order
(`GET /userstory-statuses`): the statuses [`status`](#status-and-comment) accepts, with whether moving a ticket there
closes it. `--json` prints
`{ "project": { "id", "slug", "name", "admin", "manifest" }, "issueTypes": ["Bug", …], "severities": […], "priorities": […], "storyStatuses": [{ "name": "New", "isClosed": false }, …] }`.

Read-only: it never writes to Taiga or to the repository. Errors are those of every command that reads Taiga: exit 2
when not logged in, exit 5 when Taiga refuses the login (kind `taiga`) or cannot be reached.

## Report

`taigent report --project <slug> [--json]` reads one project the user can see (exit 5 when there is none) and reports
its progress. The figures mean what the `taiga-status-report` skill reports:

- **By sprint**, newest first (`GET /milestones?project=<id>`, then `GET /milestones/<id>/stats` for each): name, first
  and last day, closed or active, stories done/total (a story is done when Taiga closed it) and tasks done/total (a
  task is done when its status is closed) from the stats, points done/total from the sprint's `closed_points` and
  `total_points`, and its blocked stories (`is_blocked`).
- **By epic** (`GET /epics?project=<id>`, then `GET /epics/<id>/related_userstories` for each): its stories done and
  open; `noEpic` counts the stories related to no epic.
- **Outside the sprints**: every story with no sprint (`milestone` null), with its status, block flag and points.

Stories come from one `GET /userstories?project=<id>`. Every list is read with pagination disabled, so no page is
missed. `--json` prints:

```json
{
  "project": { "id": 7, "slug": "vigo-auth", "name": "Vigo - Auth" },
  "sprints": [
    { "id": 31, "name": "Sprint 2", "start": "2026-10-15", "finish": "2026-10-28", "closed": false,
      "stories": { "done": 1, "total": 3 }, "tasks": { "done": 1, "total": 3 }, "points": { "done": 2, "total": 5 },
      "blocked": [{ "ref": 6, "subject": "SSO", "status": "In progress", "closed": false, "blocked": true, "points": 3 }] }
  ],
  "epics": [{ "id": 12, "ref": 1, "subject": "Auth", "stories": { "done": 1, "open": 1 } }],
  "noEpic": { "done": 2, "open": 31 },
  "outsideSprints": { "done": 1, "open": 31, "stories": [{ "ref": 8, "subject": "Backlog 1", "status": "Done", … }] }
}
```

Read-only, with the errors of every command that reads Taiga (exit 2 when not logged in, 5 when Taiga refuses the
login or cannot be reached).

## Adopt

`taigent adopt --project <slug> --ref <n> --key <KEY> [--epic <KEY> | --story <KEY>] [--json]` writes the hand-made
item `#<n>` of the project (no `src:` tag) into `backlog.yaml` as a new backlog item `<KEY>` with `ref: <n>`
([ADR 0004](adr/0004-adopt-existing-taiga-projects.md)). The skills run it once per item the user confirmed. It reads
Taiga (the project's items, and an issue's values) and writes only the manifest, through the manifest edit API:
comments and layout of the file stay, and `backlog.yaml` is created when missing. Where the item goes:

- an **epic** or an **issue**: at the end of `epics` or `issues`; `--epic` and `--story` are refused;
- a **user story**: at the end of the `stories` of the manifest epic `--epic <KEY>` (required). When the story is not
  linked to that epic on Taiga yet, `plan` also proposes the link;
- a **task**: at the end of the `tasks` of the manifest story `--story <KEY>` (required), which must be the backlog
  item the task's story on Taiga is (tagged `src:<key>`, or adopted by `ref`).

It copies, verbatim:

- the subject and the description (line endings and trailing spaces included);
- the tags a manifest may hold (`type:`/`area:` ones that follow the conventions); other tags stay on Taiga only;
- an issue's `type`, `severity` and `priority`, by name.

A story is written in the **legacy format**: its whole description in `description`, no `acceptance_criteria` split
out and no `spec`, so its template renders exactly that description (see [Manifest layout](#manifest-layout)). The
`story-format` rule allows the legacy format on `adopt`; it still refuses it on `create`.

Custom attribute values are not copied. It refuses, with exit 2 (kind `usage`) and nothing written: a closed item, an
item already carrying a `src:` tag, a ref no item of the project has, a key or ref already in `backlog.yaml`, a story
without `--epic` naming a manifest epic, a task without `--story` naming a manifest story, a task in no story or in
a story that is not a backlog item (adopt that story first), a task whose story is another backlog item than
`--story`, and a parent flag on an epic or issue. A missing or malformed `--ref`, `--key`, `--epic` or `--story`, or
both `--epic` and `--story`, is a usage error too; a new item breaking a manifest rule is exit 4. The project
directory is validated first (exit 4), unless it holds no manifest yet.

Then `plan` proposes an `adopt` operation for the item (see [Reconciliation](#reconciliation)): right after
adopting, it only adds the `src:<key>` tag, and `apply --yes` writes nothing else. Status, assignee, sprint and
points stay as they are on Taiga. Hand-made stories and tasks under an adopted epic or story stay hand-made: `plan`
lists them under `handMadeChildren`.

`--json` prints `{ "project": { "id", "slug" }, "type": "epic" | "story" | "task" | "issue", "key", "ref", "id", "path" }`,
`path` being where the item is in `backlog.yaml` (e.g. `epics[2]`, `epics[0].stories[1].tasks[0]`).

## Snapshot

`taigent snapshot --project <slug> [--json]` reads the whole backlog of one project the user can see (exit 5 when there
is none) and writes it to `<manifests root>/<slug>/snapshot.json`, creating the directory when the project has no
manifests yet. The skills run it before planning and read the file instead of the Taiga MCP lists, which return at
most 30 stories and no tasks. It holds:

- **every epic**, open and closed;
- **every open story, task and issue** (a closed one is left out: its status is closed, `status_extra_info.is_closed`);
- hand-made items (no `src:<key>` tag, `key: null`) and backlog items alike.

It reads `GET /epics`, `/userstories`, `/tasks` and `/issues?project=<id>`, `GET /epics/<id>/related_userstories` for
each epic, and the issue types, severities and priorities, every list with pagination disabled. It never writes to
Taiga (it works under `TAIGENT_READ_ONLY` too) and touches no other file. Each run replaces the file atomically. The
file is git-ignored ([`init`](#using-the-skills-in-another-project) adds `taiga/*/snapshot.json` to `.gitignore`): it
is a local copy of Taiga at `readAt`, never a manifest.

`snapshot.json`:

```json
{
  "project": { "id": 7, "slug": "vigo-auth" },
  "readAt": "2026-11-03T08:15:00.000Z",
  "epics": [
    { "id": 12, "ref": 1, "subject": "Authentication", "status": "New", "closed": false,
      "tags": ["src:auth", "type:feature"], "key": "AUTH", "description": "…" }
  ],
  "stories": [
    { "id": 40, "ref": 5, "subject": "Login form", "status": "In progress", "closed": false,
      "tags": ["src:auth-login", "frontend"], "key": "AUTH-LOGIN", "description": "…", "epics": [1] }
  ],
  "tasks": [
    { "id": 51, "ref": 9, "subject": "Build the form", "status": "New", "closed": false,
      "tags": [], "key": null, "description": "…", "story": 5 }
  ],
  "issues": [
    { "id": 60, "ref": 11, "subject": "Crash on login", "status": "New", "closed": false,
      "tags": ["src:bug-crash"], "key": "BUG-CRASH", "description": "…",
      "type": "Bug", "severity": "Normal", "priority": "High" }
  ]
}
```

- `readAt`: when Taiga was read (ISO 8601, UTC).
- Every item: Taiga `id` and `ref`, `subject`, `status` (its name; `null` when Taiga sends none), `closed`, every tag as
  Taiga stores it (lowercased; `src:` and hand-made tags alike), `key` (the uppercased key of its first `src:` tag,
  `null` for a hand-made item) and the full `description`, byte for byte (line endings and trailing spaces kept).
  Lists keep Taiga's order.
- A story's `epics`: the refs of every epic it is linked to, hand-made epics too. A task's `story`: its parent
  story's ref (that story may be closed, so not in `stories`), `null` for a task outside any story.
- An issue's `type`, `severity` and `priority`: the names of its values, `null` when it has none.

The text output is a short summary: the file, `readAt`, the count of each type and how many items are hand-made.
`--json` prints it as
`{ "file": "taiga/vigo-auth/snapshot.json", "readAt", "epics", "stories", "tasks", "issues", "handMade" }` (`file`
relative to the working directory). Errors are those of every command that reads Taiga (exit 2 when not logged in, 5
when Taiga refuses the login or cannot be reached).

## Tickets

`taigent tickets --from <YYYY-MM-DD> --to <YYYY-MM-DD> [--project <slug>] [--json]` lists the **Period's tickets**
(`GLOSSARY.md`) of the user the CLI logs in as: the user stories assigned to them that Taiga closed between the two
days, or that are due between them, plus every story still open, each with its **Due status**. Tasks and issues are not
tickets. Read-only: it needs no manifest and writes nothing. Days are calendar days in the machine's local time zone
(`TZ`), both included; `--project` keeps one project, otherwise every project the user sees. It answers what the Taiga
MCP server (taiga-mcp-server@1.9.20) cannot: no MCP tool shows when an item was closed, and `advancedSearch` matches
nothing on status, assignee or dates.

It reads `GET /users/me`, then every `GET /userstories?assigned_users=<me>` (open and closed, plus `project=<id>` with
`--project`; pagination disabled, so no page is missed), then `GET /projects/<id>` for each project holding a ticket,
to turn assignee ids into usernames and find its user story custom attribute "Spent Time", then, in a project that has
it, `GET /userstories/custom-attributes-values/<id>` for each ticket. A story is a ticket when its `finish_date` falls
in the range, its `due_date` (a plain day) falls in it, or it is open. Due status compares calendar days: a closed
ticket's local closing day on or before its due date is `On time`, after it `Late`; an open ticket's due date before
today is `Overdue`, otherwise `On track`; without a due date, `No due date`. A closed story without a `finish_date`
still counts as closed, has no `closedAt`, and is a ticket only when due in the range; its due status is `null`
(unknown, it cannot be compared).

**Effort** (`GLOSSARY.md`) is in hours. The "Spent Time" attribute is found by name in each project (trimmed, any case),
since its id differs from project to project. A ticket whose Spent Time holds a number has that effort, source
`spent` (0 included); otherwise its `total_points` (the sum of every role's points, 1 point = 1 hour), source
`points`, an estimate; with neither, `effort` and `effortSource` are null and the ticket is listed in
`notes.missingEffort` (`ref`, project slug). A project without the attribute uses points only.

Missing or invalid days, or `--from` after `--to`, are a usage error (exit 2) before Taiga is contacted. The text form
gives one line of totals (closed tickets by due status, open tickets by due status, total effort with the number of
tickets per source), then each project with one line per ticket (ref, due status, status, due date, local closing
time, effort, subject); an effort from points reads `5h (estimated from points)`, a missing one `no effort`.
`tickets --json` prints a `TicketsReport`:

```json
{
  "user": { "id": 12, "username": "son.do" },
  "project": null,
  "range": { "from": "2026-10-26", "to": "2026-11-01", "start": "2026-10-25T17:00:00.000Z", "end": "2026-11-01T17:00:00.000Z" },
  "today": "2026-11-01",
  "generatedAt": "2026-11-01T07:05:12.345Z",
  "tickets": [
    { "id": 281, "ref": 84, "subject": "Guideline flow", "status": "Done", "isClosed": true,
      "project": { "id": 11, "slug": "vigo-medical-hub", "name": "Vigo - Medical Hub" }, "assignees": ["son.do", "an.tran"],
      "dueDate": "2026-10-30", "closedAt": "2026-11-01T04:26:49.642Z", "dueStatus": "Late",
      "effort": 8, "effortSource": "spent" }
  ],
  "days": [
    { "date": "2026-10-26", "closed": 0, "effort": 0 },
    { "date": "2026-11-01", "closed": 18, "effort": 96 }
  ],
  "summary": {
    "tickets": 21,
    "closed": { "total": 19, "byDueStatus": { "On time": 1, "Late": 17, "No due date": 1 }, "withoutClosingDay": 0 },
    "open": { "total": 2, "byDueStatus": { "Overdue": 2, "On track": 0, "No due date": 0 } },
    "effort": { "hours": 104, "spent": { "hours": 60, "tickets": 11 }, "points": { "hours": 44, "tickets": 8 } },
    "projects": [{ "slug": "vigo-medical-hub", "name": "Vigo - Medical Hub", "tickets": 8 }]
  },
  "notes": {
    "bulkCloses": [{ "count": 18, "first": "2026-11-01T04:26:30.101Z", "last": "2026-11-01T04:27:41.880Z",
      "tickets": [{ "ref": 84, "project": "vigo-medical-hub" }, { "ref": 31, "project": "vigo-auth" }] }],
    "missingEffort": [{ "ref": 12, "project": "internal-taigent" }]
  }
}
```

`today` is the local day open tickets are compared with. `assignees` lists every assignee's username, or the user id
when it matches no project member. `tickets` come closed first, by `closedAt` (those without one last), then open:
`Overdue`, `On track`, `No due date`, each by due date.

`days` holds every day from `--from` to `--to`, days without a closed ticket included (0): the tickets whose local
closing day it is, and the sum of their effort in hours (a missing effort counts 0). A ticket closed before the period
(a ticket because it is due in it) appears in no day.

`summary` totals `tickets`: their number; closed ones by due status (`On time`, `Late`, `No due date`) plus
`withoutClosingDay`, the closed ones with no closing day and so no due status; open ones by due status (`Overdue`,
`On track`, `No due date`); the total effort in hours, and the hours and number of tickets of each source (`spent`,
`points`); and the number of tickets per project, most first, then by slug. Hours are rounded to hundredths.

`notes.bulkCloses` lists, by closing time, every run of 3 or more tickets each closed at most 60 seconds after the
previous one (`count`, the `first` and `last` closing instants, and `tickets` as `ref` and project slug, like
`missingEffort`): a closing day in such a run may be later
than when the work was actually done. A gap over 60 seconds starts a new run; a run of 2 is not listed.
`notes.missingEffort` lists the tickets with no effort.

## Status and comment

`taigent status --project <slug> <ref> <status> [--json]` moves the user's ticket `#<ref>` of one project to a
status; `taigent comment --project <slug> <ref> <text> [--json]` adds a comment to it. Both write at once, without
`--yes`: they touch one **ticket** (`GLOSSARY.md`) of the user, named on the command line, which is the request
itself (the skill `taiga-update-ticket` runs them from a chat message). The ref is `84` or `#84`. The words after it
are joined with spaces, so `status --project vigo-auth 84 Ready for test` needs no quotes (PowerShell 5.1 mangles
them); the status matches a status of the project by name (trimmed, any case) or slug. Words after `--` are taken as
they are, so a text that starts with `-` goes there (`comment --project vigo-auth 84 -- -x was the cause`); Taigent
Desktop passes the whole comment as one argument after `--`, line breaks included. `projects --project <slug>` lists
the project's statuses.

Both read `GET /users/me`, `GET /projects/by_slug` and the user's stories of the project
(`GET /userstories?assigned_users=<me>&project=<id>`); a ref that is not one of them (someone else's story, or no
such story) is exit 2, nothing written. `status` then reads `GET /userstory-statuses?project=<id>` (an unknown status:
exit 2, listing the project's statuses) and sends `PATCH /userstories/<id>` with `{ status, version }`; when the ticket
already has that status it writes nothing and exits 0. `comment` sends `{ comment, version }`, which Taiga keeps in the
story's history. A story changed on Taiga since it was read is a `conflict` (exit 5) with `key: "#<ref>"`.
Moving a ticket to a closed status (`Done`, `Archived`) closes it: Taiga records its closing time, which
[Tickets](#tickets) reports (3 or more closed within a minute show as a bulk close).

Text output: `#84 Login form (vigo-auth): In progress → Done`, `#84 Login form (vigo-auth) is already Done: nothing
changed`, or `Commented on #84 Login form (vigo-auth)`. `status --json` prints
`{ "ticket": { "id", "ref", "subject", "project": { "id", "slug", "name" } }, "from", "to", "isClosed", "changed" }`
(`isClosed`: whether `to` is a closed status); `comment --json` prints `{ "ticket", "comment" }`.

## Notify

`taigent notify week|day|eod [--project <slug>] [--dry-run] [--json]` builds a message about the user's tickets from
[`tickets`](#tickets) data and sends it to their Telegram chat through the Bot API (`POST /bot<token>/sendMessage`, plain
text, split at line breaks into messages of at most 4096 characters). Meant for a scheduled task (see
[Telegram](#telegram)). The messages are in Vietnamese, the team's language:

| Kind | Days read | Message |
|---|---|---|
| `week` | Monday to Sunday of today | Open tickets by group: overdue, due this week, due later, no due date; then the ones closed this week |
| `day` | today | Open tickets due today, overdue ones, and how many others are open |
| `eod` | today | Open tickets due today or earlier (the **end-of-day reminder**), and how to close them from the chat; nothing is sent when there are none |

The bot token is `TELEGRAM_BOT_TOKEN` (environment or `.env`), else the one the Claude Code Telegram plugin saved
(`/telegram:configure` writes `<TELEGRAM_STATE_DIR>/.env`). The chat is `TELEGRAM_CHAT_ID`, else the one user paired
with the plugin (`allowFrom` of `<TELEGRAM_STATE_DIR>/access.json`: a private chat's id is the user's id); none or
several paired users without `TELEGRAM_CHAT_ID` is exit 2. Missing Telegram settings fail (exit 2) before Taiga is
contacted; `--dry-run` needs none: it prints the message and sends nothing (exit 0). A message the Bot API refuses, or
an unreachable Bot API, is exit 5 with kind `telegram`. The token joins the redacted secrets.

Text output: `Sent the eod message to Telegram chat 412587349`, `Nothing to send: no open ticket is due by
2026-11-02`, or the message itself with `--dry-run`. `--json` prints
`{ "kind", "range": { "from", "to" }, "text" (null: nothing to send), "sent", "chatId" (null with --dry-run) }`.

## Telegram

Each user sets this up once, on the machine that holds their `taigent login`: the bot acts as them, so it is one bot
per user, never shared. The steps (Bun, bot, plugin, pairing, permissions, schedule) are in the README,
[§ 6. Optional: your tickets on Telegram](../README.md#6-optional-your-tickets-on-telegram). Two independent parts
use the same bot:

- **Messages**: a scheduled task (Task Scheduler, cron) runs `taigent notify week|day|eod` from the project root,
  as the user, so it finds `.env` and the stored login. It needs no Claude Code session.
- **Chat**: `claude --channels plugin:telegram@claude-plugins-official --append-system-prompt-file
  node_modules/taigent/docs/telegram-reply.md`, started in the project root and left open, receives the user's
  messages ([Channels](https://code.claude.com/docs/en/channels), research preview: needs [Bun](https://bun.sh), a
  claude.ai or Console login, and on Team/Enterprise plans an admin's approval). The model answers with
  `taiga-update-ticket`. [`telegram-reply.md`](telegram-reply.md) has it call the plugin's `reply` tool with
  `format: "markdownv2"` and bold the key facts, falling back to plain text when Telegram refuses the markup.
  `.claude/settings.json` pre-allows `npx taigent tickets|status|comment` (as `Bash(...)` and `PowerShell(...)`),
  because a skill's `allowed-tools` cover only the turn that invoked it and a follow-up chat message would otherwise
  stop at a permission prompt; other prompts reach Telegram as buttons (the plugin relays them).

The chat session does not see what `notify` sent (a bot receives no copy of its own messages, and the Bot API keeps
no history), so `taiga-update-ticket` rebuilds "close them" from `taigent tickets`: the open tickets due today or
earlier, exactly the end-of-day reminder's list at that moment.

## Login and the MCP server

**`taigent login [--application <id>]`** is run by the user, in their own terminal: it refuses to run unless stdin and
stdout are a terminal, so neither an agent nor a pipe can type the password. It asks for the API URL (or takes
`TAIGA_API_URL`; a bare `https://host` gets `/api/v1`), the username or email (or takes `TAIGA_USERNAME`) and the
password, which is never echoed and never read from the environment. It logs in once (`POST /auth`) and stores:

- `<config dir>/login.json`, not secret: `{ apiUrl, username, method, application? }`;
- one secret in the credential store (`TAIGENT_CREDENTIAL_STORE`), under service `taigent` and account `<apiUrl>`:
  - default, `method: refresh-token`: Taiga's access/refresh token pair. Taiga rotates refresh tokens (a used one is
    denylisted) and lets one live 8 days by default, so a login unused for that long must be repeated;
  - `--application <id>`, `method: application-token`: an application token (`POST /application-tokens/authorize`, then
    `validate`). It needs an Application that the instance admin created in Django admin (`/admin/` → Applications;
    Taiga has no API for it); its id is not secret. The token never expires and is revoked by `logout`.

The password is not stored anywhere. A new login replaces the previous one. Wrong credentials exit 5; an unknown
Application id exits 5 and stores nothing.

Renewal: on a 401 the stored login takes `<config dir>/login.lock` (shared by every taigent process of the user),
re-reads the store, and adopts the pair another process stored meanwhile; only when the rejected token is still the
stored one does it call `POST /auth/refresh` and store the new pair. So the CLI and any number of `taigent mcp`
processes spend one refresh token once. A refresh Taiga refuses exits 5 asking for `taigent login`. An application
token is not renewed.

**`taigent logout`** deletes `login.json` and the stored secret. With an application token it first deletes it on
Taiga (`DELETE /application-tokens/{id}`), since Taiga would hand the same one out again; if that fails, the local
login is removed anyway and the command exits 5. Taiga cannot revoke a refresh token (it has no logout endpoint).

**`taigent whoami [--json]`** checks the credentials of [Credentials and environment](#credentials-and-environment)
with `GET /users/me`: `{ "apiUrl", "user": { "id", "username" }, "credentials": { "source": "login", "method",
"store" } | { "source": "environment", "variables" } }`.

**`taigent mcp`** runs the Taiga MCP server (the `taiga-mcp-server` version pinned in `package.json`) in its own
process, on stdin/stdout, for `.mcp.json` / `.codex/config.toml`; it exits when the agent closes stdin. Nothing goes
to stdout but MCP; its messages go to stderr. With `TAIGA_USERNAME`/`TAIGA_PASSWORD` set, the server logs in with them
itself. Otherwise (stored login, or `TAIGA_TOKEN`) the server, which only knows username/password logins, talks to a
proxy on `127.0.0.1` instead of Taiga:

- the server gets the proxy URL, the stored username and a random proxy password, never a real credential;
- the proxy answers `POST /auth` with that password by `GET /users/me` on Taiga plus the proxy password as token,
  and refuses any other username/password with 401: the MCP `authenticate` tool cannot switch accounts (it is banned
  anyway, conventions §10);
- every other request must carry the proxy token; the proxy forwards it to Taiga with the stored login's
  `Authorization` header, renewing it once on 401 as above.

Limits: the credential store keeps the token out of files, not out of reach of other programs running as the same
user (an agent's shell included), and the proxy accepts any local process that knows the proxy password, which lives
in the `taigent mcp` process's environment.

## Skills

The agent skills that drive this CLI, the **Taigent skills**, are every `taiga-*` skill plus `prd-to-taiga` and the
router `ask-taigent`: [Agent Skills](https://agentskills.io/specification) with one canonical copy in `.agents/skills/`
(Codex reads it) and a byte-identical copy in `.claude/skills/` (Claude Code reads it). Edit only the
`.agents/skills/` copy, then copy:

- `taigent skills sync [--json]`: replaces every `.claude/skills/` copy of a Taigent skill that differs from its
  source and removes copies whose source is gone. Other skills (the vendored mattpocock ones) are never read or
  written.
- `taigent skills check [--json]`: exit 0 when the copies match, 3 when they differ (listing each file as
  `missing`, `changed` or `extra`). `npm test` runs it on the repository, so a forgotten sync fails the suite.

Both work on the working directory (run them from the repository root; no `.agents/skills` there is exit 2), are
offline and need no `TAIGA_*` variable. `skills check --json` prints
`{ "inSync": false, "skills": ["ask-taigent", "taiga-apply-backlog", …], "differences": [{ "skill", "file", "status" }] }`
(`file` is relative to the skill directory); `skills sync --json` prints `{ "skills", "synced", "removed" }`
(skill names).

| Skill | Invocation | Does |
|---|---|---|
| `ask-taigent` | User only (as below) | Router: which Taigent skill, workflow step or CLI command fits a situation, the plan → review → apply rules, and how to maintain the skills. Reads only |
| `taiga-setup` | Model or user | Checks `npx --no -- taigent --help`, the login (`taigent whoami`; the fix is the user running `npx taigent login` in their own terminal), and the Taiga MCP server (`listProjects`, then `claude mcp get taiga` for its approval state); names each fix (`npx taigent init` for the skills and the `taiga` entries of `.mcp.json`/`.codex/config.toml`, or that entry by hand; running `taigent mcp`, once the user agrees), and installs Taigent into another project on request (`taigent init`) |
| `prd-to-taiga` | User only (as below) | PRD (`gh issue view` of a GitHub issue, a file or pasted text) → numbers its user stories US1, US2, … → `taiga-plan-backlog` (each story's `spec:` a link developers can open, a `# USn` comment above it) → summary table Key / Story / Epic / Tasks / PRD plus the uncovered user stories → asks whether to write `taiga/<slug>/preview.md` and `.preview/base.md` (`taigent preview --out`) for the BA to edit before `taiga-apply-backlog`. Writes files only |
| `taiga-plan-backlog` | Model or user (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`, `policy.allow_implicit_invocation: true`) | Spec/PRD → reads what exists (`taigent plan --json`, read-only on Taiga; MCP read tools for hand-made work) → edits `taiga/<slug>/backlog.yaml` in place (keeps keys) → answers the open comments of `review.yaml` (`resolved` + `reply`, never verdicts; `taigent preview` offline), ends with `taigent validate`. Writes files only |
| `taiga-apply-backlog` | User only: `disable-model-invocation: true` (Claude), `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex) | When `taiga/<slug>/preview.md` exists (a `taigent preview` the BA edited, beside its untouched copy `.preview/base.md`): `git diff --no-index` of the two → writes the edits into `backlog.yaml` → `taigent validate` → refreshes both copies. Then `taigent plan` → shows it → asks → `taigent apply --yes` after an explicit yes |
| `taiga-create-user-story` | User only (as above) | One user story in the conventions §6.1 format under an existing manifest epic: drafts it, checks for duplicates (manifest, `taigent plan --json`, MCP read tools), adds it to `backlog.yaml`, `taigent validate` → `taigent plan --json` → asks → `taigent apply --yes`; hands over to `taiga-plan-backlog` when no epic fits and to `taiga-apply-backlog` when the plan holds other changes. Creates no epic or task |
| `taiga-bootstrap-project` | User only (as above) | Writes or checks `taiga/<slug>/project.yaml`, `taigent validate` → `taigent bootstrap --dry-run` → asks → `taigent bootstrap --yes` |
| `taiga-upload-docs` | User only (as above) | Updates `taiga/<slug>/docs.yaml` (referencing documents where they already are, no copies), `taigent validate` → `taigent upload --dry-run` → asks → `taigent upload --yes` |
| `taiga-status-report` | Model or user | Read-only report by sprint and by epic, or one quick count/lookup, through Taiga MCP read tools only (`listMilestones`, `getMilestone`, `getMilestoneStats`, `listEpics`, `listUserStories`, `getUserStory`, `advancedSearch`); hands questions about your own tickets to `taiga-my-tickets` |
| `taiga-my-tickets` | Model or user | Read-only report of your tickets in a period (the current week, Monday to Sunday, by default): `taigent tickets --json`, the one shell command it runs, laid out as header, summary, by day, by project, still open, notes, in the user's language |
| `taiga-update-ticket` | Model or user (`policy.allow_implicit_invocation: true`) | Finds the tickets a request names (`taigent tickets --json`; "close them" = the end-of-day reminder's list), then `taigent status` / `taigent comment` per ticket, at once, and reports each outcome |

Their `allowed-tools` pre-approve only `npx taigent validate|preview|plan|apply|bootstrap|upload|tickets|status|comment` (as
`Bash(...)` and, for Claude Code's Windows PowerShell tool, `PowerShell(...)` rules), Taiga MCP read tools, `gh issue view`
and `Skill(...)` of another Taigent skill (`prd-to-taiga` reads the PRD issue and runs `taiga-plan-backlog`); every
skill that pre-approves a plan-gated writing command (`apply`, `bootstrap`, `upload`) is user-only on both agents
(`test/skills.test.ts` enforces both rules). They grant, not restrict: the gate before `--yes` is the skill's explicit
confirmation step. `status` and `comment` edit one of the user's own tickets that the request names, so
`taiga-update-ticket` runs on its own.
Codex's skill docs do not document `allowed-tools`; there, approvals come from `.codex/config.toml`, the sandbox, the
execpolicy rule `.codex/rules/taigent.rules` and, in headless runs, the shell hook `.codex/hooks/taigent-shell-guard.mjs`
(`docs/headless.md`).

### Using the skills in another project

The CLI skills run `npx taigent` from the **project root** and first check that its `package.json` is taigent's own
or lists `taigent` as a dependency: otherwise npx would fetch an unrelated `taigent` package from the npm registry.
Another project needs, at its root:

```sh
npm install -D github:sondoquang/taigent   # the CLI and the docs the skills cite
npx taigent init                          # the skills, the MCP entries, the headless kit; pins taigent to its tag
npm install                               # installs the pinned version
```

`taigent init [--dry-run] [--json]` installs into the repository at the working directory everything Taigent needs,
taken from the running taigent (Taigent Desktop runs the copy it ships):

| Writes | What |
|---|---|
| `.agents/skills/<skill>/`, `.claude/skills/<skill>/` | The eleven Taigent skills (`taiga-*`, `prd-to-taiga`, `ask-taigent`). A Taigent skill that differs is replaced; one the running taigent does not ship is removed |
| `mcpServers.taiga` of `.mcp.json`, `[mcp_servers.taiga]` of `.codex/config.toml` | The Taiga MCP server, `node node_modules/taigent/bin/taigent.js mcp`: the entries of `taiga-setup`, no secrets |
| `tools/taiga/allowlist.txt`, `.codex/hooks/taigent-shell-guard.mjs`, `.codex/rules/taigent.rules` | The headless kit, where `run-skill` and the Codex shell guard look for it ([docs/headless.md](headless.md)) |
| `devDependencies.taigent` of `package.json` | `github:sondoquang/taigent#v<version>`, the git tag of the running version (moved out of `dependencies`). A missing `package.json` is created |
| `.gitignore` | `taiga/*/preview.md` and `taiga/*/.preview/` (the BA preview working copies) and `taiga/*/snapshot.json` (the snapshot of [`snapshot`](#snapshot)), never committed, appended under a `# Taigent:` comment when missing: an older install gets the lines it lacks, never a second copy. A missing `.gitignore` is created |

Running it again is safe. Other skills, MCP servers, keys, ignore lines and dependencies stay as they are: `.mcp.json` and
`package.json` are merged by key and keep their indentation, and `.codex/config.toml` gets its `[mcp_servers.taiga]`
table (subtables included) replaced in place or appended, every other line untouched. Every file is merged before the
first write: a file that is not valid JSON or TOML, or defines `mcp_servers.taiga` other than as a table, is exit 2
and nothing is written (so is running it in taigent's own repository). It is offline (no `TAIGA_*`), never logs in and
never runs `npm install`. `--dry-run` writes nothing and exits 3 when a file would change. `--json` prints
`{ "files": [{ "path", "status" }] }`, every file sorted by path, with `status` one of `created`, `updated`,
`unchanged` and `removed` (a file of a Taigent skill the running taigent does not have); the text form lists the files
that change.

The pin needs releases tagged `v<version>` (`v0.1.0` for 0.1.0). `npm install` from git runs the `prepare` script,
which compiles `src/` to `dist/` (`tsconfig.build.json`): under `node_modules` Node strips no types, so
`bin/taigent.js` runs `dist/` there and the TypeScript sources everywhere else. It needs read access to the repository
while it is private. The package (`files` in `package.json`) ships `bin/`, `dist/`, `docs/cli.md` and `docs/taiga/`
(the docs the skills cite, read from `node_modules/taigent/`) and what `init` installs: the Taigent skills of
`.agents/skills/`, `tools/taiga/` (with `run-skill`), the Codex hook and rule.
`init` neither logs in nor approves the MCP server. Each user runs `npx taigent login` once, in their own terminal, at
the project root; the project commits the files `init` wrote and each user approves the project server once.
`taiga-status-report` needs only the Taiga MCP server; `taiga-my-tickets` and `taiga-update-ticket` need only the CLI
(`taigent tickets`, `status`, `comment`). For chats from Telegram, also add the six `tickets|status|comment` rules of
the README's step 6e to the project's `.claude/settings.json`.
To run a skill without interaction, run `node_modules/taigent/tools/taiga/run-skill.ps1` (or `run-skill.sh`) from the
project root: it uses the project's skills and the allowlist `init` installed ([docs/headless.md](headless.md)); Taigent
Desktop's headless buttons run the same script.
`npx skills add sondoquang/taigent` still installs the skills alone (no MCP entries, kit or pin). The `taiga-setup`
skill checks all of it and names each fix.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, missing env var, not logged in, `TAIGA_API_URL` naming another Taiga than the stored login, `login` without a terminal or cancelled, unreadable credential store, unreadable `.env`, credentials in `TAIGA_API_URL`, `apply`/`bootstrap`/`upload` with changes but no `--yes`, a write to Taiga under `TAIGENT_READ_ONLY=1` ([Read-only runs](#read-only-runs)), `tickets` without valid `--from`/`--to`, `--from`/`--to` with another command, `--out` with another command than `preview`, `skills` outside a repository root, `status`/`comment` on a ref that is not one of your tickets or with an unknown status, `notify` without a bot token or a single chat, `init` on a `.mcp.json`, `.codex/config.toml` or `package.json` it cannot merge, or in taigent's own repository |
| 3 | `plan` or `--dry-run` found changes (`init --dry-run`: a file would change); `skills check` found differing copies |
| 4 | Manifest (or `review.yaml`) invalid or missing (including a new story without `use_case`/`scenarios`, or an issue type, severity or priority the project does not define, found by `plan`/`apply` after reading Taiga); nothing was written to Taiga |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, stored login expired or revoked, unknown Application, unknown project, version conflict, custom attribute name not defined on the project; bootstrap refusals (not admin, unknown role/template, slug mismatch); the Telegram Bot API refusing a `notify` message or unreachable |
| 6 | `plan`/`apply` found blocked items: changed on Taiga since taigent last wrote them (`remote-edit`), changed on both sides differently (`conflict`) or without a baseline and different from the manifest (`unknown`); see [Baseline and remote edits](#baseline-and-remote-edits). `apply --yes` wrote nothing, not even `state.json` |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`); one review gate (`reviewGate`) and one text form for every plan and report |
| Manifest | `src/manifest/` | `loadManifests`/`MANIFESTS` registry (`manifests.ts`), `loadBacklog` (and `checkBacklog(doc, path)`, the same rules on an already parsed document), `loadDocs` (and `checkDocs(doc, path, context, pending?)`, where `pending` files about to be written count as existing), conventions rules (`conventions.ts`, also `checkKeyLocked` for the edit API, and `suggestKey` + `issueKeyPrefix`, the key naming advice the desktop forms use), `readManifestYaml`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Items | `src/items.ts` | `ITEM_TYPES`/`ItemType` (`epic`, `story`, `task`, `issue`): the one item vocabulary outside the client; `ISSUE_VALUE_FIELDS` (`type`, `severity`, `priority`) |
| Secrets | `src/secrets.ts` | `Secrets` (`add`, `redact`): what no output may show, shared by the CLI (environment, typed password), the client and the stored login (tokens) and the MCP proxy |
| Login | `src/login.ts`, `src/prompt.ts` | `storeLogin`, `removeLogin`, `StoredSession` (a `TaigaAuthorizer`: the stored token, renewed under `login.lock`), `configDir`, the credential stores (`@napi-rs/keyring`, or a 0600 file); terminal-only prompts |
| MCP | `src/mcp.ts` | `startProxy` (the 127.0.0.1 proxy in front of Taiga for `taiga-mcp-server`), `serveMcp` (loads the server in-process with its `TAIGA_*` set) |
| Operations | `src/operations.ts` | the shape every plan/execute command shares: `Action` → `RESULT`, `summarize(actions, operations)` → `{ changes, summary }`, `tally` for reports, `FILL_ACTIONS` (bootstrap, upload) |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`, PATCH with `version`; item methods keyed by `ItemType`: `listItems`/`createItem`/`updateItem`, `getAttributeValues`/`updateAttributeValues`, `listAttachments`/`uploadAttachment`; `listIssueValues(field, projectId)` for an issue's type, severity and priority; `listAssignedStories` for `tickets`, `listStoryStatuses`/`editStory` for `status` and `comment`; `listMemberProjects(userId)` for `projects`; `listStories`, `listMilestones`, `getMilestoneStats` for `report`; `login`/`refresh` token pairs, `createApplicationToken`/`deleteApplicationTokens`; a `TaigaAuthorizer` option for the stored login), the only place that maps item types and issue value fields to Taiga's endpoint and field names (`TAIGA_ITEM`, `TAIGA_ISSUE_VALUES`), `TaigaError`, `TaigaAuthError` (`credential`: `token`, `password` or `login`), `TaigaConflictError` (OCC refusal; `key` set by the command that planned the write) |
| Remote reader | `src/remote.ts` | `readBacklogRemote(backlog, client, slug)`: reads the project, its items, epic links (of epics tagged `src:` or adopted by `ref`), issue values (when the backlog has issues) and attribute values `buildPlan` needs |
| Managed values | `src/managed.ts` | pure `manifestManagedValues(entry)` and `remoteManagedValues(type, item, remote, attributes, backlogKey?)` → `ManagedValues` (plain JSON, also the baseline stored in `state.json`): the fields taigent owns on an item (subject, description, `type:`/`area:` tags, declared custom attributes, an issue's type/severity/priority names, a task's story key, a story's epic keys), projected the same way from the manifest and from Taiga (`backlogKey` resolves a Taiga epic or story to its backlog key: its `src:` tag by default, the planner adds adopted items); `differingFields(manifest, remote)` (tags and epic links additive), `remoteEditedFields(baseline, remote, manifest)` (what changed on Taiga since the baseline), `keyOf(item)`. Status, assignee, sprint, points and unprefixed tags are outside the projection |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote, stateItems)` → `{ plan, baselines }` (operations `create`, `update`, `adopt`, `link`, `skip`, orphans, stale links, blocked items and `handMadeChildren`, plus the baseline apply records per key, adopted items included), or `RefMismatchError` naming the backlog items whose `ref` does not match Taiga (reported as `item-ref` issues of `backlog.yaml`), `LegacyStoryCreateError` naming the stories it would create in the legacy format (the CLI reports them as `story-format` issues of `backlog.yaml`), or `UnknownIssueValueError` naming the issue values the project does not define (reported as `issue-value` issues), `describePlanOperation`, `srcTag(key)` |
| Adopt | `src/adopt.ts` | `adoptItem(dir, slug, client, { ref, key, parent? })` → `AdoptResult` (writes `backlog.yaml` through `saveItem`, never Taiga), `AdoptError` (exit 2): the `adopt` command; one case per item type in `backlogItem`, `parent` (`{ type: 'epic' \| 'story', key }`) required for a story and a task |
| Story template | `src/story-template.ts` | pure `storyDescription(story)`: the description apply writes for a story, shared by the planner, `preview` and Taigent Desktop's story form (bundled into its renderer, so the module imports nothing from Node) |
| Review | `src/review.ts` | `loadReview(path, keys?)`/`saveReview`, `reviewKeys(backlog)` (the keys `review.yaml` may name), pure `setVerdict`/`addComment`, pure `rekeyReview(review, keys)` and `rekeyReviewFile(dir, keys)` (a renamed item keeps its comments and loses its verdict; a removed one loses its entry), `itemDigest`, `buildPreview(dir, slug)` → `Preview` (epic tree + `issues`), `renderPreviewMarkdown`: the offline `preview` command and the library Taigent Desktop uses |
| Manifest edit | `src/edit.ts` | the library Taigent Desktop's forms write `backlog.yaml` and wiki pages with: `readManifestFile(dir, 'backlog' \| 'docs')` → `{ file, text, digest }` (SHA-256 of the file); pure `readItem(text, type, key)` → the epic/story/task/issue as its form edits it (`BacklogItem`, every field present, a story in its own format: `useCase` + `scenarios` or `acceptanceCriteria`; saving it back unchanged changes nothing); `saveItem(dir, { baseDigest, original?, item })` adds or edits an epic/story/task/issue (`item` = `{ type, key, parent?, fields }`, no `parent` for an issue, whose `fields` add `type`/`severity`/`priority`; a new key renames, a new parent moves the item with its children; a story's `useCase`/`scenarios` replace `acceptance_criteria` and the reverse); `removeItem(dir, { baseDigest, type, key })` removes any item with its children and returns `removed` and `orphaned` (those in state.json). `readWikiPages(dir)` → `{ docs, pages: [{ slug, file, page }] }` (docs.yaml and each page's Markdown file, with digests); `saveWikiPage(dir, { baseDigest, pageDigest?, page: { slug, content } })` adds a page (no `pageDigest`: entry `{ slug, file: pages/<slug>.md }` at the end of `wiki`, the file must not exist yet) or edits one (writes the file its entry names, wherever it is; docs.yaml untouched; CRLF kept) and returns `path` (`wiki[i]`) and `page`; both digests are checked before anything is written, and a page whose docs.yaml write then meets a conflict is taken back. Every write returns `EditResult`: `saved` (new `digest`), `conflict` (the file, backlog.yaml, docs.yaml or the page, no longer has the digest given; `current` is the file now, nothing written) or `invalid` (`issues` with `path` + `rule`: the `checkBacklog`/`checkDocs` issues under the edited item or wiki entry only, `key-unique` (`checkKey`, on the edited item's key, issues included), `key-reference` for a missing item or parent, `key-locked` (`checkKeyLocked`) for a new key on an item in state.json, `wiki-slug`/`wiki-slug-unique` for a page's slug, `wiki-reference` for an edit of a slug docs.yaml does not have). Edits go through yaml's Document API, so comments, order, quoting, flow style and line ends of untouched nodes stay; the writes of one process run one at a time (a digest check and its write never interleave), each atomic. review.yaml is never touched: an edited item's verdict turns stale through its digest, and the caller runs `rekeyReviewFile` after a rename or removal; wiki pages are not reviewed. Where each item type sits and its field order is the `KINDS` table; the issue form adds its input to `BacklogItem` |
| Files | `src/files.ts` | `sha256(text)` (the digest every form reads and its write is checked against) and `writeAtomic(path, text)` / `temporaryPath(path)` (a unique `.<name>.<uuid>.tmp` beside the file, renamed over it): shared by the edit API, the project settings and `saveReview` |
| Executor | `src/executor.ts` | `executePlan({ plan, baselines }, client, statePath, customAttributes)`, `describeAppliedOperation` |
| Bootstrap | `src/bootstrap.ts`, `src/manifest/project.ts` | `loadProject`; `readBootstrapRemote(manifest, client, statePath)`, pure `planBootstrap(manifest, remote)`, `executeBootstrap(plan, project, client, statePath)` |
| Upload | `src/upload.ts` | `readUploadRemote(docs, backlog, client, slug)` (reads Taiga, hashes files), pure `planUpload(docs, remote, cwd)`, `executeUpload(plan, client, cwd)`, `UploadTooLargeError` (carries `file`) |
| Skills | `src/skills.ts` | `compareSkills(root)`, `syncSkills(root)`: the Taigent skills (`taiga-*`, `prd-to-taiga`, `ask-taigent`), `.agents/skills/` → `.claude/skills/`; `compareSkillDirs(source, target)` (file by file, `same` included) and `copySkills(source, target, comparison)` for any two directories |
| Init | `src/init.ts` | `initRepository(root, { dryRun })` → `InitReport` (`files: [{ path, status }]`), `InitError` (exit 2): the offline `init` command, copying from the running package (`src/`'s parent: the repository, or `node_modules/taigent` when installed) |
| Tickets | `src/tickets.ts` | `parseDay`, `dayRange(from, to)`, `readTickets(client, range, project?)` → `TicketsReport`, `formatTicketsText`: the read-only `tickets` command |
| Projects | `src/projects.ts` | `readProjects(client, manifestsRoot)` → `ProjectsReport`, `readProjectDetail(client, slug, manifestsRoot)` → `ProjectDetailReport` (issue values and `storyStatuses`), `formatProjectsText`, `formatProjectDetailText`: the read-only `projects` command |
| Report | `src/report.ts` | `readProjectReport(client, slug)` → `ProjectReport` (sprints, epics, `noEpic`, `outsideSprints`), `formatProjectReportText`: the read-only `report` command |
| Snapshot | `src/snapshot.ts` | `readSnapshot(client, slug)` → `Snapshot` (GET only), `writeSnapshot(path, snapshot)`, `summarizeSnapshot`, `formatSnapshotText`: the read-only `snapshot` command; the file is `projectLayout(...).snapshot` (`SNAPSHOT_FILE` in `src/manifest/layout.ts`) |
| Project settings | `src/project-settings.ts` | `readProjectSettings(manifestsRoot, slug)` → `ProjectSettingsFile` (form fields, `digest`, validate issues), `saveProjectSettings(manifestsRoot, settings, { slug?, baseDigest })` → `saved` / `conflict` / `invalid`: the project.yaml form of Taigent Desktop (in-place yaml Document edit, digest check, validate loader, atomic write) |
| Ticket edits | `src/ticket.ts` | `setTicketStatus`, `commentTicket` (the user's own story by ref, OCC), `parseRef`, `TicketError` (exit 2) |
| Notify | `src/notify.ts` | `notifyRange`, `notifyMessage(kind, report)`, `resolveTelegram(env)` (token and chat, from the environment or the Telegram plugin's state directory), `sendTelegram`, `NotifyConfigError` (exit 2), `TelegramError` (exit 5) |

Every plan/execute command has the same three steps: a reader (`read*Remote`, all I/O), a pure planner, an executor.
The CLI only wires them (`runPlan`, `runBootstrap`, `runUpload`) and prints.

Adding a manifest kind: write `load<Kind>(path, context)` that reads with `readManifestYaml`, reports every
problem through an `issue(path, rule, message)` sink (reusing the `check*` functions of `conventions.ts`) and
throws one `ManifestError`; then add its type to `Manifests` and an entry to `MANIFESTS` in `manifests.ts`, in
dependency order (`context.loaded` holds the manifests loaded before it, `context.invalid` the ones that failed).
`validate` and every command then pick it up. New rules go in `conventions.ts` and `docs/taiga/conventions.md`.

## Tests

`npm test` (Node's built-in runner) and `npm run typecheck`. Tests go through the CLI seam, except the library APIs
other programs call directly, each tested on a temporary directory: `storeLogin`, the review API of `src/review.ts`
(`test/review.test.ts`), and the APIs Taigent Desktop's forms call: the manifest edit API of `src/edit.ts`
(`test/edit.test.ts`) and the project settings API of `src/project-settings.ts` (`test/project-settings.test.ts`).
`test/support/harness.ts` (`startHarness(t)`) spawns `bin/taigent.js` in a temp working directory against
`test/support/fake-taiga.ts` (`startFakeTaiga()`), an in-process fake of the Taiga API that validates
payloads like Taiga (and additionally rejects unknown fields). Extend the fake rather than mocking modules. Every run
gets `TAIGENT_CONFIG_DIR` = `h.configDir` (in the temp directory) and `TAIGENT_CREDENTIAL_STORE=file`, so no test
touches the developer's stored login or OS credential store; `test/login.test.ts` stores a login with `storeLogin`
(what `taigent login` runs after its terminal prompts) and drives `taigent mcp` over MCP JSON-RPC on stdin/stdout.

Fake API used by the tests (`FakeTaiga` in `test/support/fake-taiga.ts`):

- `fake.url` (TAIGA_API_URL, includes `/api/v1`) and `fake.user` (`{ id, username, password, email }`, the account
  `POST /auth` accepts; the harness logs in with it).
- Seeding: `addEpic`, `addUserStory`, `addTask` (`{ project, subject, description?, tags? }`, plus
  `user_story?` for tasks), `addIssue` (the same plus `type?`, `severity?`, `priority?`, `status?` ids; the project's
  defaults otherwise), `addEpicRelatedUserStory(epic, story)`, `addMilestone({ project, name, estimated_start,
  estimated_finish, closed? })` (a sprint: set `milestone` on stories and tasks to put them in it; `GET /milestones`
  embeds its stories and their summed `total_points`/`closed_points`, `GET /milestones/<id>/stats` counts its stories
  by `is_closed` and its tasks by `is_closed`); bootstrap fixtures `addUser`, `addProject({ slug,
  name?, members?, admins?, is_private?, modules?, tagsColors? })` (`GET /projects?member=<user id>` lists the projects
  of that member the caller can see, like taiga-back's `member` filter, with `i_am_admin`), `addCustomAttribute`, `addMembership`,
  `addWikiPage`; upload fixtures `addAttachment({ project, objectType: "epics" | "userstories" | "tasks" | "wiki",
  object_id, name, content })`. For `tickets`, set the returned story's `assigned_users`, `is_closed`, `finish_date`,
  `due_date` (YYYY-MM-DD), `total_points` (number or null), `is_blocked` and `status_name` (its status name when open or closed, null
  for the default): list responses embed `project_extra_info` and `status_extra_info` (closed stories `Done`, closed
  tasks `Closed`, otherwise `New`, unless `status_name` is set), and `GET /userstories` filters on `assigned_users`,
  ignoring the other names like Taiga. A ticket's
  Spent Time: `addCustomAttribute({ itemType: "userstory", project, name: "Spent Time" })`, then
  `editAttributeValues("userstory", storyId, { [attributeId]: hours })`. Every project gets the default template's
  story statuses (`state.storyStatuses`: `New`, `Ready`, `In progress`, `Ready for test`, `Done` and `Archived`
  closed), served by `GET /userstory-statuses?project=`; a story PATCH with `status` sets its `status_name`,
  `is_closed` and `finish_date` (set on closing, cleared on reopening), and a `comment` lands in `state.comments`
  (`{ itemType, item, user, comment }`). `test/notify.test.ts` runs its own Bot API stand-in through
  `TAIGENT_TELEGRAM_API_URL`; the harness drops the developer's `TELEGRAM_*` and `CLAUDE_CONFIG_DIR`.
- Edits like a Taiga user (bump `version`, recorded for OCC): `editItem(item, changes)`, `editWikiPage(page, changes)`,
  `editAttributeValues(itemType, itemId, values)`.
- `fake.state`: what Taiga holds, the place to assert outcomes. `epics`, `userStories`, `tasks`, `issues` (tags
  lowercased; an issue holds `type`, `severity`, `priority`, `status` ids, `assigned_to`, `milestone`, `is_closed`), `milestones`
  (`{ id, project, name, slug, estimated_start, estimated_finish, closed }`),
  `issueStatuses`, `issueTypes`, `severities`, `priorities` (`{ id, project, name, order, color }`; every project gets
  the default templates' values, and `default_issue_status`/`default_issue_type`/`default_severity`/`default_priority`),
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
  Credentials and environment (401 → `/auth/refresh` → new login order, at most 5 retries per 429, `Retry-After` waits via `at`).
- Failure injection: `fake.intercept({ method, path, status, body?, bodyFrom?, headers?, after?, times? })` answers the
  matching request(s) with a canned reply (`path` a string or RegExp below `/api/v1`; `bodyFrom(request)` builds the body
  from the recorded request, e.g. to echo credentials; `headers` e.g. `retry-after`; `after` lets that many through
  first; `times` default 1). `fake.onRequest({ method, path, run, times? })` runs a callback just before a request is
  handled (e.g. `fake.editItem(story, { subject })` to simulate a concurrent edit).
- Tokens: `fake.issueToken()` returns a valid access token without a login (for `TAIGA_TOKEN`);
  `fake.expireTokens({ after?, refresh? })` expires all access tokens after `after` more authenticated requests (and
  revokes refresh tokens with `refresh: true`); `fake.issuedTokens` lists every access and refresh token issued, for
  leak checks (application tokens included).
- Application tokens: `fake.addApplication(name)` registers an Application (as an admin does in Django admin);
  `POST /application-tokens/authorize` / `validate`, `GET /application-tokens?application=` and
  `DELETE /application-tokens/{id}` behave like taiga-back, `Authorization: Application <token>` authenticates, and
  `fake.state.applications` / `applicationTokens` hold them.
- `fake.settings`: `projectSlugPrefix = true` mimics DEFAULT_PROJECT_SLUG_PREFIX; `maxBodyBytes = n` answers any larger
  request body with nginx's HTML 413 page, like Taiga's reverse proxy (`client_max_body_size`).

Fidelity: the fake implements Taiga's OCC (PATCH needs `version`; a stale one fails only when the same fields changed
meanwhile), 30-item pagination unless `x-disable-pagination`, taiga-back's `tags=a,b` filter on the epic, story, task
and issue lists (items with any listed tag, exact match; taigent itself does not use it and matches `src:` tags
client-side), and the post-save empty custom attribute values object (version 1) of every epic/story/task/issue, served
at `/{epics,userstories,tasks,issues}/custom-attributes-values/{id}` (keys must be ids of the project's attributes of
that type; PATCH replaces the object and needs its own `version`). Issues: `GET /issue-statuses`, `/issue-types`,
`/severities`, `/priorities?project=` list the project's values; `POST /issues` and `PATCH /issues/{id}` give an
issue without a value the project's default (taiga-back `Issue.save`), refuse an unknown value id with 400 and one of
another project with 403 (`pre_conditions_on_save`), and a status sets `is_closed`. It parses `multipart/form-data`
with Node's own parser (`Response#formData`), computes attachment `size`/`sha1` from the bytes like taiga-back and
rejects unknown form fields.

Live smoke test: `npm run test:live` runs `test/live/*.live.ts` against a real Taiga project. It is opt-in
(`TAIGENT_LIVE_SMOKE=1`, target `TAIGENT_SMOKE_PROJECT`), never part of `npm test`, and only run by a person:
see `docs/live-smoke.md`. `test/live-smoke.test.ts` runs it against the fake in `npm test`.

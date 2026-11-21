# `taigent` CLI

Headless CLI that applies declarative manifests to Taiga through its REST API, and edits or reports on the user's
own tickets. Agents and skills call it through the shell; it is the only path for writes to Taiga (MCP stays
read-only).

## Running

Requires Node.js 24+. In the repository it runs the TypeScript sources directly; installed from npm
(`npm i -g taigent`) it runs the build in `dist/`, compiled before publishing (see [Releasing](#releasing)).

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
  },
  "adopted": {
    "LOGIN": {
      "type": "story", "id": 40, "ref": 9, "version": 4,
      "baseline": { "subject": "Log in", "description": "…", "tags": [], "custom_attributes": {}, "epics": ["AUTH"] }
    }
  }
}
```

`items` records what apply wrote. `adopted` is written by [`adopt`](#adopt): for each backlog item it took over and
apply has not adopted yet, the Taiga item's `type`, `id`, `ref`, `version` and the managed values it copied, as plan
projects them (its baseline). Apply moves the entry into `items` once it has written the adopt. Neither map is an
identity: that stays the `src:` tag or the manifest's `ref`.
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

Taiga's item lists (`GET /epics?project=<id>`, `/userstories`, `/tasks`, `/issues`) leave the description out; only
an item's detail (`GET /userstories/<id>`, …) has it. `plan`, `apply` and `pull` therefore read the detail of each
item they compare (tagged `src:<key>`, or adopted by `ref`), 8 requests at a time, and never take a description
missing from a list for an empty one; hand-made items they only list are not read one by one.

`plan` compares each item tagged `src:<key>` three ways, B = baseline, T = Taiga, M = manifest. An item adopted by
`ref` (no `src:<key>` tag yet) is compared the same way against its `adopted` baseline, the values `adopt` copied: an
edit on Taiga between `adopt` and `apply` blocks it. An item with a hand-written `ref` and no `adopted` entry has no
baseline and is never blocked; its `adopt` operation records its first baseline, and from the next plan on it is
compared like any tagged item.

An item `state.json` records (key → id) that is found on Taiga without its `src:<key>` tag is never created again: plan
reports it blocked, kind `remote-edit`, field `tags`. Settle it by restoring the `src:<key>` tag on Taiga, or by
writing the item's `ref: <n>` in `backlog.yaml`, so apply adopts it again (compared three ways against its recorded
baseline). `pull` refuses it (exit 4, kind `pull`), naming those two ways.

| B | T vs B | M vs B | M vs T | Result |
|---|---|---|---|---|
| present | same | same | | skip |
| present | same | changed | | update |
| present | changed | same | | blocked: `remote-edit` |
| present | changed | changed | same | skip (apply refreshes the baseline) |
| present | changed | changed | different | blocked: `both-edited` (all three versions) |
| missing | | | same | skip (apply records the baseline) |
| missing | | | different | blocked: `unknown` (Taiga's and the manifest's version) |

"M vs B" and "M vs T" compare like an update does (tags and epic links additive: dropping one from the manifest is
no change). "T vs B" compares prefixed tags as sets (adding or removing one on Taiga is a remote edit), epic links of
the manifest's epic only, and declared custom attributes only (a value never recorded counts as unset). A blocked
item gets no operation; `plan`, `apply --dry-run` and `apply` without `--yes` print the plan with its `blocked` list and
exit 6, and `apply --yes` refuses with exit 6 (kind `blocked`) before any write, leaving Taiga and `state.json`
untouched. Settle each one with [`taigent pull`](#pull): it takes Taiga's values into `backlog.yaml` (the agent then
merges any manifest change back in), or with `--keep-manifest` keeps the manifest's and only moves the baseline, then
plan again. Keeping the manifest is the user's deliberate choice after seeing the item, never a default. The first
run after upgrading shows items applied earlier that differ from Taiga as `unknown`.

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

Common options: `--project <slug>` (required except for `setup`, `validate`, `tickets`, `projects`, `notify`, `skills`, `login`, `logout`, `whoami` and `mcp`; `setup --project` takes no slug), `--json` (machine-readable stdout),
`--yes`, `--dry-run`, `-h/--help`. `--dry-run` lists the operations a writing command (`bootstrap`, `apply`, `upload`)
would run and writes nothing, not even `state.json`; it exits 3 when there are changes, 0 otherwise (`apply --dry-run`
is the same as `plan`; `setup --dry-run` and `setup --project --dry-run` list the files they would write). Without `--yes` or `--dry-run`, a writing
command prints the same operations, writes nothing and exits 2 when there are changes.

- `taigent setup [--dry-run] [--json]`: installs the Taigent skills and the Taiga MCP server `taiga` (the global
  `taigent mcp`, no secrets) into the user config of every client found in the home directory: Claude Code, Codex,
  OMP. Writes at once (no `--yes`), then logs in when there is no login and checks the login and the MCP server, and
  reports skills older than it and copies installed both for the user and in the working directory. See
  [Installing for the user](#installing-for-the-user), [Setup: login and checks](#setup-login-and-checks) and
  [Setup: skill versions and duplicates](#setup-skill-versions-and-duplicates).
- `taigent setup --project [--dry-run] [--json]`: installs Taigent into the repository at the working directory, from
  the running taigent: the Taigent skills, the Taiga MCP server entries, the headless kit and the `taigent`
  devDependency pinned to its npm version. `--project` takes no value here. Writes at once (no `--yes`), then logs in,
  checks and reports like `setup`. See [Using the skills in another project](#using-the-skills-in-another-project).
- `taigent validate [--project <slug>] [--json]`: checks every manifest present in `taiga/<slug>/` (all project
  directories without `--project`) against the schema and the conventions, and `review.yaml` when present (see
  [Review](#review)). Offline: needs no `TAIGA_*` variable and never contacts Taiga. Exit 0 when valid, 4 otherwise.
  `--json` prints `{ "valid": true, "projects": [{ "slug", "files": ["taiga/demo/backlog.yaml", …] }] }`.
- `taigent preview --project <slug> [--out <file>] [--json]`: the backlog as `apply` would write it, with its
  review; offline. See [Review](#review).
- `taigent review approve|request-changes|comment|resolve --project <slug> <key> … [--json]`: records a verdict, a
  review comment or a resolved comment with its reply in `review.yaml`; offline. See [Review](#review).
- `taigent plan --project <slug> [--json]`: reads Taiga, prints the operations `apply` would run, the blocked items
  (see [Baseline and remote edits](#baseline-and-remote-edits); exit 6 when any) and the orphans. Never writes.
- `taigent apply --project <slug> --yes [--json]`: runs the plan in order, writing `state.json` after each
  write to Taiga (a failed run resumes where it stopped). It stops at the first error, naming the operation and
  key. Without `--yes` it prints the plan, writes nothing (not even `state.json`) and exits 2 when there are
  changes. While any item is blocked it writes nothing and exits 6.
- `taigent adopt --project <slug> --ref <n> --key <KEY> [--epic <KEY> | --story <KEY>] [--json]`: writes the
  hand-made epic, user story (under manifest epic `--epic`), task (under manifest story `--story`) or issue `#<n>`
  into `backlog.yaml` as backlog item `<KEY>` and its copied values into `state.json`'s `adopted` map; reads Taiga,
  writes local files only. See [Adopt](#adopt).
- `taigent pull --project <slug> [--key <KEY>] [--keep-manifest] [--json]`: writes Taiga's values of a backlog item,
  or of every blocked item, into `backlog.yaml` and makes them their baseline in `state.json`; reads Taiga, writes
  local files only. See [Pull](#pull).
- `taigent tickets`, `taigent status`, `taigent comment`, `taigent notify`: see [Tickets](#tickets),
  [Status and comment](#status-and-comment) and [Notify](#notify).
- `taigent projects [--project <slug>] [--json]`: the Taiga projects you are a member of, or the issue values of one
  project; read-only. See [Projects](#projects).
- `taigent report --project <slug> [--json]`: the project's progress by sprint and by epic, and its stories in no
  sprint; read-only. See [Report](#report).
- `taigent sprint list|create|add --project <slug> …`: lists the sprints with their stories, creates
  a sprint, or puts user stories into one (`create`/`add` need `--yes`). See [Sprint](#sprint).
- `taigent snapshot --project <slug> [--json]`: writes every epic and every open story, task and issue of the
  project, hand-made ones too, to `taiga/<slug>/snapshot.json`; read-only on Taiga. See [Snapshot](#snapshot).
- `taigent metrics --project <slug> [--cache-dir <dir>] [--json]`: the dashboard metrics of the project, the source of
  the `taiga-dashboard` skill; read-only on Taiga, `--cache-dir` keeps the items' history between runs. See
  [Metrics](#metrics).
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
`blocked` lists the items plan leaves alone: `kind` is `remote-edit`, `both-edited` or `unknown`; `fields` holds each
managed field that differs between any two versions, with its `baseline` (absent for `unknown`), `taiga` and
`manifest` values as in `state.json`'s baseline (e.g. `tags` are the prefixed tags, `epics` epic keys).
`adopt.changes` has the shape of `update.changes`, and always holds `tags`; an adopted item is blocked only against
its `adopted` baseline (see [Baseline and remote edits](#baseline-and-remote-edits)). `handMadeChildren` lists the hand-made stories (`parent`: the manifest
epic's key) and tasks (`parent`: the manifest story's key) under backlog items.
Custom attribute values add `custom_attributes: { "<name>": value }` to `create`, and
`changes.custom_attributes: { from: { "<name>": value | null }, to: { "<name>": value }, version }` to `update`
(`null`: not set on Taiga; `version`: the values object's). An update of values alone does not PATCH the item.

`apply --yes --json` prints an `ApplyReport`: `{ project, operations: [{ action, type, key, id, ref, epic?, result }],
summary: { created, updated, adopted, linked, unchanged } }`; `result` is `created`, `updated`, `adopted`, `linked` or `unchanged`, and
`epic` (the epic key) is set on `link` operations, whose `id`/`ref` are the story's.

Errors print `taigent: <message>` on stderr; with `--json`, stdout also gets
`{ "error": { "kind": "usage" | "login" | "validation" | "taiga" | "conflict" | "blocked" | "pull" | "telegram", "message", "issues"?, "status"?, "key"?, "blocked"?, "description"? } }`
(`login`: no stored login, or `login` run without a terminal; `pull`: Taiga's values of item `key` do not fit the
manifest, see [Pull](#pull); `telegram`: the Bot API refused or could not be reached).
Validation issues have the shape `{ file, path, rule, message }`, e.g. `epics[1].stories[0].key` / `key-unique`.
`conflict` means Taiga refused an update because the item changed on Taiga after apply read it (OCC); `key`
names the item, nothing was overwritten, and re-running `plan` shows the new state. `blocked` (exit 6) means
`apply --yes` refused because of blocked items, listed in `blocked` with the shape of the plan's; nothing was written.
The text form is `<file>: <path>: <message> [<rule>]`. `plan`/`apply` validate the whole project directory the
same way (and require `backlog.yaml`) before contacting Taiga; after reading Taiga they also refuse a `ref` that does
not match Taiga (rule `item-ref`), a story to create in the legacy format (rule `story-format`) and an issue value the
project does not define (rule `issue-value`), see [Reconciliation](#reconciliation), still before any write.

## Review

Before `apply`, the Business Analyst / Product Owner reviews the backlog the agent wrote with `taigent preview`, and
records verdicts and comments with `taigent review` (skill `taiga-review-backlog`, which the reviewer invokes).
Verdicts and comments live in `taiga/<slug>/review.yaml`, committed
with the manifests; the agent answers the comments by editing the manifests, then `taigent review resolve` (skill
`taiga-plan-backlog`). The review
never writes to Taiga, and `plan`/`apply` ignore `review.yaml`: apply still needs the user's explicit approval
(`docs/taiga/conventions.md` §1).

`taigent preview --project <slug> [--out <file>] [--json]` reads `backlog.yaml` (required; the whole project
directory is validated like `plan`), `state.json`, `review.yaml` and `snapshot.json` when there is one, offline (no
`TAIGA_*` variable, no login). The text form is one Markdown page: a summary table (epics, stories, tasks, issues, new /
to adopt / on Taiga, approved, changes requested, not reviewed, stale, open comments and, with a snapshot, the remote
edits, both-edited and unknown items), the snapshot's `readAt` (or, without one, the `taigent snapshot` command to run), then
each epic → story → task, then an **Issues** section with each issue's type, severity and priority; every item with its
badges, tags, custom attributes, review status and comments, and its description exactly as apply writes it (a
story's includes its acceptance criteria and spec link). An item's first badge says where it stands on Taiga:
`on Taiga #<ref>` (from `state.json`), `adopt #<ref> (hand-made on Taiga)` (a `ref` in the manifest while `state.json`
does not record the key yet: apply adopts that item, see [Adopt](#adopt); the badge goes once apply has recorded it)
or `new (not on Taiga yet)`.

**Remote badges** come from [`snapshot.json`](#snapshot): preview makes, offline, the three-way comparison of
[Baseline and remote edits](#baseline-and-remote-edits) with the snapshot instead of Taiga (`blockedFields` of
`src/managed.ts`, the code `plan` runs), so an item shows **remote edit on Taiga**, **both edited: on Taiga and in the manifest, differently** or
**unknown: differs from Taiga, no baseline**, with the snapshot's time and the fields concerned, exactly when `plan`
would block it if Taiga were still as the snapshot read it. Its counterpart is the snapshot item tagged `src:<key>`
(the oldest, as in plan), else, for an item adopting one by `ref`, that item compared with its `adopted` baseline;
there is no remote badge for an item adopted by `ref` without an `adopted` entry (no baseline, as in plan), one the snapshot does
not hold (closed stories, tasks and issues are left out of it), or one whose snapshot `version` is below the one
`state.json` records (the snapshot was read before taigent last wrote it). The snapshot holds no custom attribute
values, so they never show as edited on Taiga (plan still compares them). Without `snapshot.json` there is no remote
badge; run `taigent snapshot --project <slug>` for a fresh copy. `--json` prints the `Preview` object of
`src/review.ts` (`{ project: { slug, name? }, snapshot?: { readAt }, summary, epics: [{ …item, stories: [{ …item,
format, scenarios, spec, tasks }] }], issues: [{ …item, values: { type, severity, priority } }] }`, `format` being
`user-story` or `legacy`, `scenarios` the story's Gherkin scenarios as in the manifest (`[{ scenario, given: [..], when,
then }]`, empty for a legacy story), `values` the names as in the manifest, each item `{ type, key, subject, description, tags, customAttributes,
parent?, applied?: { id, ref }, adopt?: { ref }, blocked?: { kind: remote-edit | both-edited | unknown, fields }, digest,
review: { verdict?, stale, by?, at?, comments, openComments } }`; `summary` counts `epics`, `stories`, `tasks` and
`issues`, `new`, `adopt` and `applied` (they add up to the items), the review states over all of them, and `blocked`
by kind, `{ "remote-edit", "both-edited", unknown }`, all 0 without a snapshot). `--out <file>` writes the page (or the
JSON) to that file instead and prints `Preview written to <file>` (`{ "out": "<file>" }` with `--json`). Exit 0; 4 when
a manifest or `review.yaml` is invalid.

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
        resolved: true             # default false; review resolve sets it once the manifest addresses the comment
        reply: Đã thêm tiêu chí khoá 15 phút.   # optional, the agent's short answer (review resolve)
```

An item's **digest** is the SHA-256 of what apply writes for it: subject, description as written (a story's with
its acceptance criteria and spec), tags (lowercased, order-insensitive), custom attributes, parent key and, for an
issue, its type, severity and priority names. A verdict
whose digest differs from the item's current one is **stale**: the item changed after it was reviewed, so it counts
as stale, not as approved. Editing `review.yaml` never changes a digest, and the digest leaves the key out. Files are
written with sorted keys (`saveReview`); items with neither a verdict nor a comment are dropped.

`validate` reports, besides the generic `type`, `required` and `known-field` rules: `key-format` for item keys,
`review-verdict` (a verdict other than `approved`/`changes`) and `review-comment-unique` (a duplicate comment id within
an item). Nobody edits `review.yaml` by hand. An entry whose key the backlog no longer declares (the item was removed,
or its key renamed before apply) is not an issue: it stays in the file and is ignored, and `preview` lists it in
`summary.unknownReviewKeys` with a warning. Renaming a key before apply therefore drops its review: the reviewer
reviews the item again under its new key.

`taigent review approve|request-changes|comment|resolve --project <slug> <key> … [--json]` writes `review.yaml`,
offline (no `TAIGA_*` variable, no login), through `recordReview` of `src/review.ts`, the one code path that writes it:

- `review approve <key>`: verdict `approved`; `review request-changes <key> [-- <comment>]`: verdict `changes`, plus an
  open comment when text follows. Both record the item's current digest (as `preview` computes it) and `at` (now), so
  editing the item afterwards makes the verdict stale and the item awaiting review again. A new verdict replaces the
  previous one; comments stay.
- `review comment <key> -- <text>`: adds an open comment with the next free id (`c1`, `c2`, …); the verdict stays.
- `review resolve <key> <comment-id> -- <reply>`: marks that comment `resolved: true` with `reply` (resolving it again
  replaces the reply); its text, author and time stay.

As with `taigent comment`, the words after the key (and the comment id) are the text; put it after `--` when it
contains words starting with `-`. `review.yaml` records no reviewer or role: verdicts are written without `by`, and the
comments `review` writes have `by: reviewer` (the field is required). Exit 0 and, with `--json`,
`{ "key", "digest", "review": { verdict?, digest?, at?, comments }, "comment"?: { id, by, at, text, resolved, reply? } }`
(`comment`: the one added or resolved). Exit 2, nothing written: a key not in `backlog.yaml` (e.g. after the item was
renamed), a comment id the item lacks, a missing or unknown subcommand, a malformed key, text after `approve`, or a
missing text (`comment`) or reply (`resolve`). Exit 4: a manifest or `review.yaml` is invalid, as for `preview`. Run
`taigent validate --project <slug>` afterwards.

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
releases:                           # optional, read only by `metrics` (release burndown); bootstrap ignores it
  - version: v1-2-0                 # required, kebab-case, unique: the stories tagged release:v1-2-0 on Taiga
    target: 2026-12-01              # required, target day YYYY-MM-DD
```

`existing: true` declares a Hand-made project that already exists on Taiga: the `project-name` and `project-slug`
rules do not apply (`name` must be non-empty, `slug` is the project's real Taiga slug, still equal to the directory
name), and bootstrap never creates it. When no visible project has the slug, bootstrap exits 5 before any write
(`--dry-run` too); otherwise it fills the gaps like for any existing project.

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

## Sprint

Sprints belong to the people doing the work (conventions §6): manifests and `apply` never write them. `taigent sprint`
is the one place that does, run by a person through the review gate (`--yes` writes, `--dry-run` only plans).

- `taigent sprint list --project <slug> [--json]`: every sprint (Taiga milestone) of the project, newest first, with
  the refs and subjects of its user stories (`GET /milestones?project=<id>` and `GET /userstories?project=<id>`).
  Read-only. `--json` prints `{ "project": { "id", "slug", "name" }, "sprints": [{ "id", "name", "start", "finish",
  "closed", "stories": [{ "ref", "subject" }] }] }` (days as YYYY-MM-DD).
- `taigent sprint create --project <slug> --name <name> --from YYYY-MM-DD --to YYYY-MM-DD [--yes|--dry-run] [--json]`:
  creates the sprint with `POST /milestones` `{ project, name, estimated_start, estimated_finish }` (Taiga derives the
  slug). `--from` must not be after `--to`. A sprint with that exact name and those days already there: unchanged,
  nothing written. That name with other days: exit 2 (`error.kind` `usage`), the sprint is never changed.
- `taigent sprint add --project <slug> --name <sprint name> <ref> [<ref>…] [--yes|--dry-run] [--json]`: puts each
  user story `#<ref>` (`84` or `#84`) into the sprint named exactly `--name`, with `PATCH /userstories/<id>`
  `{ milestone, version }` (the version read with the story, OCC like `status`; a story changed on Taiga meanwhile is
  a `conflict`, exit 5, naming `#<ref>`). A story already in the sprint is unchanged; one in another sprint is moved.
  An unknown sprint name, or a ref that is no user story of the project (a task, an issue, another project's), is
  exit 2 before anything is written.

`create` and `add` go through the same review gate as `bootstrap` and `upload`: without `--yes` they print the plan
(`+` create, `~` update, `skip`) and exit 2 when there are changes, 0 when none; `--dry-run` prints it and exits 3 when
there are changes; `--yes` writes and prints the report (`created`/`updated`/`unchanged` counts). `--json` prints the plan
(`project`, `operations` with `action`, `changes`, `summary`; `add` also `sprint: { id, name }` and per story `ref`,
`id`, `subject`, `from` sprint or null, `version`) or the report (the same operations with `result`). `sprint` is not in
the headless allowlist (`tools/taiga/allowlist.txt`): it is run by a person, not by a headless skill.

## Adopt

`taigent adopt --project <slug> --ref <n> --key <KEY> [--epic <KEY> | --story <KEY>] [--json]` writes the hand-made
item `#<n>` of the project (no `src:` tag) into `backlog.yaml` as a new backlog item `<KEY>` with `ref: <n>`
([ADR 0006](adr/0006-adopt-existing-taiga-projects.md)). The skills run it once per item the user confirmed. It reads
Taiga (the project's items, and an issue's values) and writes only local files: the manifest, through `src/backlog-write.ts`
(comments and layout of the file stay, and `backlog.yaml` is created when missing), and `state.json`'s `adopted` map
(below). Where the item goes:

- an **epic** or an **issue**: at the end of `epics` or `issues`; `--epic` and `--story` are refused;
- a **user story**: at the end of the `stories` of the manifest epic `--epic <KEY>` (required). When the story is
  linked on Taiga to one or more epics, `--epic` must be one of them (the manifest epic tagged `src:<key>` on Taiga,
  or whose `ref` is that epic); otherwise adopt that epic first. A story linked to no epic may be adopted under any
  manifest epic: `plan` then shows a `link` operation, so adopting an unlinked story also links it to `--epic`;
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
without `--epic` naming a manifest epic, a story linked on Taiga to epics none of which is `--epic` (adopt that epic
first), a task without `--story` naming a manifest story, a task in no story or in
a story that is not a backlog item (adopt that story first), a task whose story is another backlog item than
`--story`, a parent flag on an epic or issue, and a `backlog.yaml` changed by someone else while adopting (it reads
the file's digest before reading Taiga and checks it before writing). A missing or malformed `--ref`, `--key`,
`--epic` or `--story`, or both `--epic` and `--story`, is a usage error too; a new item breaking a manifest rule is
exit 4. The project directory is validated first (exit 4), unless it holds no manifest yet.

Besides `backlog.yaml`, it records the item in the `adopted` map of `state.json` (see
[Identity and state](#identity-and-state)): its `type`, `id`, `ref`, `version` and the managed values it copied, as
baseline. The `adopt` plan compares the item three ways against that baseline, like any applied item: Taiga changed
since `adopt` blocks it (`remote-edit` or `both-edited`), settled with [`pull`](#pull), which then updates its
`adopted` baseline. `apply --yes` moves the entry into `items` once it has written the adopt.

Then `plan` proposes an `adopt` operation for the item (see [Reconciliation](#reconciliation)): right after
adopting, it only adds the `src:<key>` tag, and `apply --yes` writes nothing else. Status, assignee, sprint and
points stay as they are on Taiga. Hand-made stories and tasks under an adopted epic or story stay hand-made: `plan`
lists them under `handMadeChildren`.

`--json` prints `{ "project": { "id", "slug" }, "type": "epic" | "story" | "task" | "issue", "key", "ref", "id", "path" }`,
`path` being where the item is in `backlog.yaml` (e.g. `epics[2]`, `epics[0].stories[1].tasks[0]`).

## Pull

`taigent pull --project <slug> [--key <KEY>] [--keep-manifest] [--json]` settles remote edits
([Baseline and remote edits](#baseline-and-remote-edits), [ADR 0006](adr/0006-adopt-existing-taiga-projects.md)):
Taiga is the truth, the manifest a draft of what is not applied yet. It plans like `plan` (same validation and errors,
exit 4 or 5) and takes the backlog item `<KEY>`, which must be tagged `src:<key>` on Taiga or being adopted by `ref`
(exit 2 when it is not in `backlog.yaml` or not on Taiga yet), or without `--key` every item the plan blocks (none: it
prints that there is nothing to pull, exit 0). It reads `backlog.yaml`'s digest before reading Taiga, and refuses with
exit 2 (kind `usage`), writing nothing, when the file changed meanwhile. For each item, it writes Taiga's managed
values into `backlog.yaml`, through `src/backlog-write.ts` (comments and layout stay), and sets the item's baseline in
`state.json` to them (its `adopted` baseline for an item not applied yet), so the next plan skips it:

- subject, description, the prefixed tags, the declared custom attributes (one unset on Taiga leaves the manifest)
  and an issue's type, severity and priority names;
- a story's description, in the story's own format: the user story format parsed back into `use_case`,
  `description`, `scenarios` and `spec`; the legacy format with `acceptance_criteria` or `spec` parsed back into
  `description`, `acceptance_criteria` and `spec`. The parse must render Taiga's description again byte for byte. A
  legacy story with neither `acceptance_criteria` nor `spec` (the shape `adopt` writes) takes Taiga's whole
  description as its `description`, which always succeeds;
- a task's story and a story's epic: a task moved on Taiga to another backlog story, or a story linked only to another
  backlog epic, moves there in `backlog.yaml`.

When Taiga's values do not fit the manifest (a description edited outside the template, a task in no backlog story,
a story in no or several backlog epics, an issue without a value, an attribute value that is not a string, number or
boolean, an item `state.json` records that lost its `src:<key>` tag on Taiga), it exits 4 with `error.kind` `pull`,
`error.key` and, for a description, Taiga's raw text in `error.description`; nothing is written, not `backlog.yaml`
nor `state.json`, for any item. The agent then rewrites the item in `backlog.yaml` from that text in the item's own
format (the user story format for a user-story-format story; for a legacy story, re-splitting its
`acceptance_criteria` with the user, never converting it to the user story format) and pulls it with
`--keep-manifest`. A lost `src:` tag is settled by restoring it on Taiga or writing the item's `ref` in `backlog.yaml`.

`--keep-manifest` leaves `backlog.yaml` as it is and only sets the baselines to Taiga's current values: the next plan
proposes an update that writes the manifest's values. That settles a `both-edited` item once the manifest holds the
merge, an `unknown` item whose manifest wins, or a deliberate overwrite: the user's choice, never the default.

It never writes to Taiga. A pulled item's content changes, so its review
verdict turns stale ([Review](#review)). `--json` prints
`{ "project": { "id", "slug" }, "keepManifest", "pulled": [{ "type", "key", "id", "ref", "kind", "fields" }] }`:
`kind` is the item's blocked kind (`remote-edit`, `both-edited`, `unknown`) or `null` when it was not blocked, `fields`
the managed fields where Taiga and the manifest differed (a blocked item's `fields` keys).

## Snapshot

`taigent snapshot --project <slug> [--json]` reads the whole backlog of one project the user can see (exit 5 when there
is none) and writes it to `<manifests root>/<slug>/snapshot.json`, creating the directory when the project has no
manifests yet. The skills run it before planning and read the file instead of the Taiga MCP lists, which return at
most 30 stories and no tasks. It holds:

- **every epic**, open and closed;
- **every open story, task and issue** (a closed one is left out: its status is closed, `status_extra_info.is_closed`);
- hand-made items (no `src:<key>` tag, `key: null`) and backlog items alike.

It reads `GET /epics`, `/userstories`, `/tasks` and `/issues?project=<id>`, `GET /epics/<id>/related_userstories` for
each epic, the detail of every item it holds (`GET /epics/<id>`, `/userstories/<id>`, `/tasks/<id>`,
`/issues/<id>`, 8 at a time: the lists leave the description out), and the issue types, severities and priorities,
every list with pagination disabled. It never writes to
Taiga and touches no other file. Each run replaces the file atomically. The
file is git-ignored ([`setup --project`](#using-the-skills-in-another-project) adds `taiga/*/snapshot.json` to `.gitignore`): it
is a local copy of Taiga at `readAt`, never a manifest.

`snapshot.json`:

```json
{
  "project": { "id": 7, "slug": "vigo-auth" },
  "readAt": "2026-11-03T08:15:00.000Z",
  "epics": [
    { "id": 12, "ref": 1, "version": 3, "subject": "Authentication", "status": "New", "closed": false,
      "tags": ["src:auth", "type:feature"], "key": "AUTH", "description": "…" }
  ],
  "stories": [
    { "id": 40, "ref": 5, "version": 2, "subject": "Login form", "status": "In progress", "closed": false,
      "tags": ["src:auth-login", "frontend"], "key": "AUTH-LOGIN", "description": "…", "epics": [1] }
  ],
  "tasks": [
    { "id": 51, "ref": 9, "version": 1, "subject": "Build the form", "status": "New", "closed": false,
      "tags": [], "key": null, "description": "…", "story": 5 }
  ],
  "issues": [
    { "id": 60, "ref": 11, "version": 1, "subject": "Crash on login", "status": "New", "closed": false,
      "tags": ["src:bug-crash"], "key": "BUG-CRASH", "description": "…",
      "type": "Bug", "severity": "Normal", "priority": "High" }
  ]
}
```

- `readAt`: when Taiga was read (ISO 8601, UTC).
- Every item: Taiga `id`, `ref` and `version` (Taiga's change counter, the one `state.json` records after a write),
  `subject`, `status` (its name; `null` when Taiga sends none), `closed`, every tag as Taiga stores it (lowercased;
  `src:` and hand-made tags alike), `key` (the uppercased key of its first `src:` tag, `null` for a hand-made item) and
  the full `description`, byte for byte (line endings and trailing spaces kept). Lists keep Taiga's order.
- A story's `epics`: the refs of every epic it is linked to, hand-made epics too. A task's `story`: its parent
  story's ref (that story may be closed, so not in `stories`), `null` for a task outside any story.
- An issue's `type`, `severity` and `priority`: the names of its values, `null` when it has none.

[`preview`](#review) reads the file offline for its remote edit, both-edited and unknown badges.

The text output is a short summary: the file, `readAt`, the count of each type and how many items are hand-made.
`--json` prints it as
`{ "file": "taiga/vigo-auth/snapshot.json", "readAt", "epics", "stories", "tasks", "issues", "handMade" }` (`file`
relative to the working directory). Errors are those of every command that reads Taiga (exit 2 when not logged in, 5
when Taiga refuses the login or cannot be reached).

## Metrics

`taigent metrics --project <slug> [--cache-dir <dir>] [--json]` computes the metrics of the dashboards (`GLOSSARY.md`,
section Dashboards) from what Taiga holds now about one project; its `--json` is what the `taiga-dashboard` skill
reports, each role's metrics first. It only reads: the project (`GET /projects/by_slug`,
whose Backlog module flag decides the cadence), the user it logs in as (`GET /users/me`), the sprints
(`GET /milestones?project=<id>`, not read for a kanban project), the user story, task and issue statuses
(`GET /userstory-statuses?project=<id>`, `GET /task-statuses?project=<id>`, `GET /issue-statuses?project=<id>`), the
issue types (`GET /issue-types?project=<id>`), and every user story, task and issue (`GET /userstories?project=<id>`,
`GET /tasks?project=<id>`, `GET /issues?project=<id>`), each list read with pagination disabled so no page is missed;
then, like `report`, each sprint's stats (`GET /milestones/<id>/stats`), the epics (`GET /epics?project=<id>`) and each
epic's stories (`GET /epics/<id>/related_userstories`), 8 requests at a time; then the history
(`GET /history/userstory/<id>`, `GET /history/task/<id>`, `GET /history/issue/<id>`: one request per item, 8 at a time)
of every user story, task and bug; no metric reads the history of an issue that is not a bug. An item is never
skipped for an old `modified_date`: Taiga's board and sprint drags record the move in the history but leave
`modified_date` as it was (below). When a history read fails no other one starts, the command fails (exit 5), and
with `--cache-dir` the histories read so far are kept for the next run.
Locally it reads the `releases` of `taiga/<slug>/project.yaml` (none when the file does not exist), and, for the
Business Analyst's metrics, the project's `backlog.yaml`, `state.json` and `review.yaml` through the same preview as
[`preview`](#review); a missing or invalid backlog manifest never fails the command (see below). The metrics are
computed by a pure module from that snapshot and the local day (TZ).

**History cache.** Without `--cache-dir` every history is read on each run and nothing is written anywhere. With
`--cache-dir <dir>` (created when missing; relative to the working directory) the histories are kept in
`<dir>/history-<slug>-<hash>.json`, one file per Taiga instance and project (the hash is of the API URL and the
project id), each history under its item type and id with the item's fingerprint when it was read: its
`modified_date`, status id, sprint (stories and tasks), closed flag and closing date (`finish_date` /
`finished_date`). The next run reads Taiga's history again only for the items whose fingerprint changed or that are
new. `modified_date` alone would miss moves: dragging a story on the Kanban board or into a sprint updates its row
without moving `modified_date`, though Taiga records the change in the history (taiga-back
`update_userstories_kanban_order_in_bulk`, `update_userstories_milestone_in_bulk`); such a move always changes its
status, sprint, closed flag or closing date. The file is rewritten with the items the project still has, atomically
(a temporary file next to it, renamed over it, removed when the write fails). It keeps only what the metrics use:
status and sprint changes, and that the description changed, not its text. A file that cannot be parsed, of another
format version, or of another instance or project is ignored: every history is read again and the command still
succeeds. A directory where the file cannot be written is a usage error (exit 2, below).

- **Periods**: with the Backlog module on (`cadence: "sprint"`), the last 6 sprints that have started, by first day;
  `current` is the open sprint holding today. With it off (a kanban project, `cadence: "week"`), the last 6 weeks,
  Monday to Sunday in local time, ending with this week, and a `kanban` warning: there are no sprint metrics. Oldest
  first.
- **Closed** always means the closed flag of the item's status in the project's status list (Taiga's `is_closed`),
  never the status's name: `Ready for test` is open in the default templates. The closing day is the story's
  `finish_date` or the task's `finished_date`, in local time.
- User stories and tasks are always counted apart. A story is assigned to each of its `assigned_users` (and
  `assigned_to`), a task to its `assigned_to`. `me` is the user the CLI logs in as, as in [Tickets](#tickets).
- A **Bug** is an issue whose type is named `Bug`; a story tagged `type:bug` is not one. A bug is **resolved** when its
  status is named `Ready for test` or `Closed`, and **rejected** when it is named `Rejected`: the only place the
  metrics go by a status's name, because the glossary defines a resolved bug by it. The day it was resolved or rejected
  comes from its history (below), else its `finished_date` (set when it closes), in local time; open at a day means not
  closed by the status flag then.

`developer` holds, for the whole team (`all`) and for `me` (`mine`):

- `periods`: per period, the stories and the tasks **assigned** (open at some time in the period, created on or before
  its last day and not closed before its first, and assigned to someone) and **completed** (closed in the period).
- `leadTime`: the median **Lead time** in days, from the local day an item was created to the day it was closed, of
  the stories and of the tasks closed in the periods, with the number of items (`count`); `medianDays` is null without
  any.
- `cycleTime`: the median **Cycle time** in days, likewise, from the local day an item first entered the status named
  `In progress` to the day it was closed. The start comes from the item's history: its first status change into
  `In progress`, or its creation when its first status change leaves `In progress` (Taiga records no change for the
  status an item is created in). A status goes by its name in the project's status list (the history's own name only
  for a status no longer in it). Items that never entered `In progress` are left out; `Ready for test` is not closed.
- `workload`: the **Workload** of each assignee with open work (open stories, open tasks, points of those stories), by
  username, then the unassigned row (`assignee: null`, always present). A story with two assignees counts for both.
- `blocked`: the open stories, then tasks, that are blocked (`is_blocked`), by ref; `overdue`: the open ones whose due
  day is before today, compared by calendar day like the **Due status** (due today is not overdue), earliest first.
  Each item carries its `assignees` (user ids; `people` names the project's members), so a client narrows the lists
  to `me` itself.
- `bugs.periods`: per period, the bugs **resolved** in it (moved into `Ready for test` or `Closed` in it, by the
  issue's history; once each, however often) and the bugs **rejected** in it (moved into `Rejected` in it, likewise,
  so a bug rejected and reopened later stays rejected in that period; counted apart: a rejected bug has no
  resolution time), the median **Resolution time** (`resolutionTime.medianDays`, from the local day a bug was created
  to its last resolution in the period) over the resolved ones created on a known day (`count`), the bugs
  **reopened** in it (moved from `Ready for test` or `Closed` back to an open status; out of `Rejected` is not a
  reopen) and the **reopen rate** (`reopenRate`: reopened over resolved in the period, null when none was resolved;
  it can exceed 1). A bug whose history records no status change is resolved, or rejected, on the day it was closed
  when its status is now resolved, or `Rejected`. `mine` counts the bugs assigned to `me`.

`productOwner` holds:

- `currentSprint`: the open sprint holding today (the latest, if two do), or null: its `id`, `name`, `start`, `finish`,
  `stories`, `tasks` and `points` done out of total (the figures of its row in `report`), `days` (`elapsed`: days from
  its first day to today; `total`: to its last day) and `ideal`: every day from first to last with the points left on
  the ideal line, linear from all of them on the first day to 0 on the last (2 decimals).
- `velocity`: the points closed (`closed_points`) in each of the last 6 closed sprints, oldest first, with the sprint's
  `sprint` id (`sprint:<id>`, as in `periods`), `name`, `start` and `finish`.
- `planned`: per sprint of `periods`, the points **planned** and **completed**, with `basis: "sprint-start"`: planned
  is the points of the stories in the sprint at the end of its first day (local time), rebuilt from the milestone
  changes of each story's history (a story created right in a sprint counts from the day it was created; one without
  a sprint change has been in its sprint since then); completed is the sprint's closed points now (`closed_points`).
  Points are each story's points now: the history of points is not read.
- `scopeChange`: per sprint of `periods`, the **Scope change**: the stories `added` to it and `removed` from it after
  its first day, up to its last (a move after the sprint finished, such as carrying a story over, is not one), each
  with `id`, `ref`, `subject`, `points` (now; null when not estimated) and the local `day` of the move, by day then
  ref, and the sum of their `points`. A story added and taken out again is listed on both sides.
- `health`: four signals, each with a `level` (`green`, `yellow`, `red`) and a `reason` with the figures; the
  thresholds are fixed:
  - `sprintPace`: how far the current sprint's points left stand above its ideal line today, in points
    (`behindPoints`, negative when ahead) and in % of its points (`behindPercent`): more than 10% is yellow, more than
    25% red. Green with `sprint`, `behindPoints` and `behindPercent` null when no open sprint holds today.
  - `overdue`: the open `stories` and `tasks` of `developer.overdue`: 1 or 2 is yellow, 3 or more red.
  - `openBugs`: `risingPeriods`, how many periods in a row, ending with the current one, ended with more open bugs
    than the period before (`bugTrend`'s `open`, counted up to 2): 1 is yellow, 2 red.
  - `blocked`: the open blocked user `stories` (blocked tasks do not count): 1 is yellow, 2 or more red.
- `report`: the tables of [`taigent report --json`](#report) (`sprints`, `epics`, `noEpic`, `outsideSprints`), without
  its `project`, computed by the same code from the same reads.
- `bugTrend`: per period, the bugs **created** in it, **resolved** in it, **rejected** in it and **reopened** in it
  (as in `developer.bugs`), and the bugs **open** at its last day: created by then and, by the issue's history, in an
  open status at the end of that day, so a bug reopened and closed again counts as open in between. A bug whose
  history records no status change is open until the day it was closed.
- `releaseBurndown`: the **Release burndown** ([conventions §4.1](taiga/conventions.md#41-releases), ADR 0005). A
  release is the user stories carrying exactly one tag `release:<version>` on Taiga; its target day comes from
  `releases` in `project.yaml`. `releases` lists the declared releases in the manifest's order, then the undeclared
  tags by version; each has its `version`, `tag`, `declared`, `target` (null when undeclared), `start` (the local day
  its earliest story was created, null without stories), `stories` (`total`, `closed`), `points` (`total`, `closed`,
  `remaining`; unestimated stories count 0) and `days`: every day from `start` to today, or to the target when later,
  with `remaining` (points of its current stories not yet closed at the end of that day, by `finish_date`; null after
  today) and `ideal` (linear from `points.total` on `start` to 0 on the target day, 0 after it; null for an undeclared
  release). `multiTagged` lists the stories carrying two release tags or more (`id`, `ref`, `subject`, `releases`),
  left out of every burndown.

A kanban project has no `currentSprint`, `velocity`, `planned`, `scopeChange` or `health.sprintPace`, and its `report.sprints` is
empty (its sprints are not read).

`businessAnalyst` holds:

- `statuses.stories`: how many user stories on Taiga are in each status (`{ status, closed, count }`), every status of
  the project in its order: `New` is a story still being analysed, `Ready` one with complete acceptance criteria.
  `statuses.notApplied`: the backlog's stories not on Taiga ("Chưa apply"): not in `state.json` yet, or recorded there
  with a story Taiga no longer has.
- `requirementChange`: per period, the **Requirement changes**: edits of a user story's description on Taiga after the
  story first reached the status `Ready`, from each story's history: `changes` (the edits whose local day falls in the
  period) and `stories`, the stories edited in it by ref (`ref`, `subject`, `changes`). A story reached `Ready` at its
  first status change into it, or at its creation when its first status change leaves `Ready` (or it has none and is in
  `Ready`); an edit saved together with the move into `Ready` does not count, later edits do whatever the status then.
  A status goes by its id in the project's status list (the history may name it in another language). Taken from
  Taiga, so it is there without a backlog manifest too.
- `acceptanceCriteria`: how many of the backlog's stories (`stories`) have **Complete acceptance criteria**
  (`complete`, and `rate` = complete / stories rounded to 3 decimals, null without any story), and the others
  (`incomplete`) with their `epic` and `reason`: `legacy` (the legacy format never counts), `no-scenario`, or
  `incomplete-scenarios`: every scenario misses its Given, When or Then, a blank text (only spaces) counting as missing;
  `scenarios` then lists each one's `missing` parts (`given`, `when`, `then`).
- `requirementsCoverage`: how many epics (`epics`) have at least one story with complete acceptance criteria
  (`covered`, `rate`), and the epics without any (`uncovered`).
- `awaitingReview`: the backlog items (epics, stories, tasks, issues, in manifest order) with no verdict
  (`reason: "unreviewed"`) or a stale one (`reason: "stale"`), whoever reviewed; `changes` is a verdict, not awaiting.
- `pendingClarification`: the backlog items with an open review comment, with those comments (`id`, `by`, `at`,
  `text`); a resolved comment no longer counts.

Each backlog item there is `{ type, key, subject, ref }`, `ref` being its Taiga ref from `state.json` (null while new).
Without `backlog.yaml` only `statuses.stories` and `requirementChange` are there: the other metrics are listed in
`unavailable` with `reason: "backlog-missing"`, with a `backlog-missing` warning. When a manifest of the project or
`review.yaml` is invalid, likewise with `reason: "backlog-invalid"` (and that warning); the message names the first
issue and says to run `taigent validate --project <slug>`. The command still exits 0.

`unavailable` lists the metrics the run could not compute, with a `reason` code and a message: those that need the
backlog manifest (`backlog-missing`, `backlog-invalid`). `warnings` holds
the `kanban` warning, the release warnings: `release-undeclared` (a `release:` tag `project.yaml` does not declare;
drawn without an ideal line), `release-empty` (a declared release no story carries) and `release-multiple` (one per
story with two release tags or more), and the `backlog-missing` and `backlog-invalid` warnings. `--json` prints:

```json
{
  "project": { "id": 7, "slug": "vigo-auth", "name": "Vigo - Auth" },
  "generatedAt": "2026-11-05T03:12:45.120Z",
  "today": "2026-11-05",
  "cadence": "sprint",
  "periods": [
    { "id": "sprint:30", "name": "Sprint 1", "start": "2026-10-15", "finish": "2026-10-28", "current": false },
    { "id": "sprint:31", "name": "Sprint 2", "start": "2026-10-29", "finish": "2026-11-11", "current": true }
  ],
  "developer": {
    "me": { "id": 5, "username": "son" },
    "people": [{ "id": 5, "username": "son" }, { "id": 6, "username": "lan" }],
    "periods": [
      { "period": "sprint:30", "all": { … }, "mine": { … } },
      { "period": "sprint:31",
        "all": { "stories": { "assigned": 4, "completed": 1 }, "tasks": { "assigned": 6, "completed": 3 } },
        "mine": { "stories": { "assigned": 2, "completed": 1 }, "tasks": { "assigned": 3, "completed": 2 } } }
    ],
    "leadTime": {
      "all": { "stories": { "medianDays": 9, "count": 5 }, "tasks": { "medianDays": 2.5, "count": 8 } },
      "mine": { "stories": { "medianDays": 7, "count": 2 }, "tasks": { "medianDays": 2, "count": 4 } }
    },
    "cycleTime": {
      "all": { "stories": { "medianDays": 5, "count": 4 }, "tasks": { "medianDays": 1.5, "count": 8 } },
      "mine": { "stories": { "medianDays": 4, "count": 2 }, "tasks": { "medianDays": 1, "count": 4 } }
    },
    "workload": [
      { "assignee": 6, "username": "lan", "stories": 2, "tasks": 3, "points": 8 },
      { "assignee": null, "username": null, "stories": 5, "tasks": 1, "points": 13 }
    ],
    "blocked": [
      { "type": "story", "id": 812, "ref": 6, "subject": "SSO", "status": "In progress", "assignees": [6, 5],
        "dueDate": "2026-11-04", "blocked": true, "points": 3 }
    ],
    "overdue": [
      { "type": "task", "id": 951, "ref": 14, "subject": "Migrate", "status": "In progress", "assignees": [],
        "dueDate": "2026-11-02", "blocked": false, "points": null },
      { "type": "story", "id": 812, "ref": 6, "subject": "SSO", … }
    ],
    "bugs": {
      "periods": [
        { "period": "sprint:30", "all": { … }, "mine": { … } },
        { "period": "sprint:31",
          "all": { "resolved": 3, "rejected": 1, "resolutionTime": { "medianDays": 4, "count": 3 }, "reopened": 1, "reopenRate": 0.3333333333333333 },
          "mine": { "resolved": 1, "rejected": 0, "resolutionTime": { "medianDays": 2, "count": 1 }, "reopened": 0, "reopenRate": 0 } }
      ]
    }
  },
  "productOwner": {
    "currentSprint": {
      "id": 31, "name": "Sprint 2", "start": "2026-10-29", "finish": "2026-11-11",
      "stories": { "done": 1, "total": 5 }, "tasks": { "done": 3, "total": 9 }, "points": { "done": 5, "total": 21 },
      "days": { "elapsed": 7, "total": 13 },
      "ideal": [
        { "day": "2026-10-29", "points": 21 },
        { "day": "2026-10-30", "points": 19.38 },
        …
        { "day": "2026-11-11", "points": 0 }
      ]
    },
    "velocity": [{ "sprint": "sprint:30", "name": "Sprint 1", "start": "2026-10-15", "finish": "2026-10-28", "points": 13 }],
    "planned": {
      "basis": "sprint-start",
      "sprints": [
        { "period": "sprint:30", "planned": 15, "completed": 13 },
        { "period": "sprint:31", "planned": 18, "completed": 5 }
      ]
    },
    "scopeChange": [
      { "period": "sprint:30", "added": { "points": 0, "stories": [] }, "removed": { "points": 0, "stories": [] } },
      { "period": "sprint:31",
        "added": { "points": 3, "stories": [{ "id": 812, "ref": 14, "subject": "Export CSV", "points": 3, "day": "2026-11-02" }] },
        "removed": { "points": 0, "stories": [] } }
    ],
    "health": {
      "sprintPace": { "level": "red", "sprint": "sprint:31", "behindPoints": 6.31, "behindPercent": 30,
        "reason": "Sprint 2 is 6.31 points (30%) behind the ideal line: 16 of 21 points left on day 7 of 13, ideally 9.69" },
      "overdue": { "level": "yellow", "reason": "1 open story and 1 open task overdue", "stories": 1, "tasks": 1 },
      "openBugs": { "level": "green", "risingPeriods": 0,
        "reason": "open bugs at the end of the periods did not rise in the last one (7 → 5)" },
      "blocked": { "level": "yellow", "reason": "1 open user story is blocked", "stories": 1 }
    },
    "report": { "sprints": [ … ], "epics": [ … ], "noEpic": { … }, "outsideSprints": { … } },
    "bugTrend": [
      { "period": "sprint:30", "created": 5, "resolved": 2, "rejected": 0, "reopened": 0, "open": 7 },
      { "period": "sprint:31", "created": 2, "resolved": 3, "rejected": 1, "reopened": 1, "open": 5 }
    ],
    "releaseBurndown": {
      "releases": [
        { "version": "v1-2-0", "tag": "release:v1-2-0", "declared": true, "target": "2026-11-07",
          "start": "2026-11-03", "stories": { "total": 3, "closed": 1 },
          "points": { "total": 8, "closed": 3, "remaining": 5 },
          "days": [
            { "day": "2026-11-03", "remaining": 8, "ideal": 8 },
            { "day": "2026-11-04", "remaining": 5, "ideal": 6 },
            { "day": "2026-11-05", "remaining": 5, "ideal": 4 },
            { "day": "2026-11-06", "remaining": null, "ideal": 2 },
            { "day": "2026-11-07", "remaining": null, "ideal": 0 }
          ] },
        { "version": "v1-3", "tag": "release:v1-3", "declared": false, "target": null, "start": "2026-11-05",
          "stories": { "total": 1, "closed": 0 }, "points": { "total": 2, "closed": 0, "remaining": 2 },
          "days": [{ "day": "2026-11-05", "remaining": 2, "ideal": null }] }
      ],
      "multiTagged": [{ "id": 830, "ref": 9, "subject": "Export", "releases": ["v1-2-0", "v2-0-0"] }]
    }
  },
  "businessAnalyst": {
    "statuses": {
      "stories": [
        { "status": "New", "closed": false, "count": 3 }, { "status": "Ready", "closed": false, "count": 2 },
        { "status": "In progress", "closed": false, "count": 4 }, { "status": "Ready for test", "closed": false, "count": 1 },
        { "status": "Done", "closed": true, "count": 9 }, { "status": "Archived", "closed": true, "count": 0 }
      ],
      "notApplied": 2
    },
    "requirementChange": [
      { "period": "sprint:30", "changes": 1, "stories": [{ "ref": 41, "subject": "Reset password", "changes": 1 }] },
      { "period": "sprint:31", "changes": 3, "stories": [
        { "ref": 41, "subject": "Reset password", "changes": 2 }, { "ref": 44, "subject": "SSO", "changes": 1 }
      ] }
    ],
    "acceptanceCriteria": {
      "stories": 12, "complete": 9, "rate": 0.75,
      "incomplete": [
        { "type": "story", "key": "AUTH-RESET", "subject": "Reset password", "ref": 41, "epic": "AUTH",
          "reason": "legacy", "scenarios": [] },
        { "type": "story", "key": "BILL-PAY", "subject": "Pay", "ref": null, "epic": "BILL",
          "reason": "incomplete-scenarios", "scenarios": [{ "scenario": "No receipt", "missing": ["then"] }] }
      ]
    },
    "requirementsCoverage": {
      "epics": 4, "covered": 3, "rate": 0.75,
      "uncovered": [{ "type": "epic", "key": "BILL", "subject": "Billing", "ref": null }]
    },
    "awaitingReview": [
      { "type": "story", "key": "AUTH-RESET", "subject": "Reset password", "ref": 41, "reason": "stale" },
      { "type": "epic", "key": "BILL", "subject": "Billing", "ref": null, "reason": "unreviewed" }
    ],
    "pendingClarification": [
      { "type": "story", "key": "AUTH-SSO", "subject": "SSO", "ref": 6,
        "comments": [{ "id": "c1", "by": "Lan", "at": "2026-11-02T09:30:00.000Z", "text": "Which providers?" }] }
    ]
  },
  "warnings": [
    { "code": "release-undeclared", "message": "user stories carry the tag release:v1-3 but project.yaml declares no release v1-3: …" },
    { "code": "release-multiple", "message": "user story #9 Export carries release:v1-2-0, release:v2-0-0: …" }
  ],
  "unavailable": []
}
```

Without `--json` it prints a summary: the periods, the developer figures (team, then `mine`; lead time, then cycle
time), the workload, the blocked and overdue items, the bug resolution per period, the product owner figures (current
sprint, velocity, completed/planned points, scope change per sprint with the stories added and removed, health, then
`report`'s tables as `report` prints them), the bug trend, one line per release, the Business Analyst's figures
(stories by status, the requirement changes per period, the stories with incomplete acceptance criteria and why, the
uncovered epics, the items awaiting review and pending clarification), the warnings and the metrics not available yet.

Read-only on Taiga; it writes only the history cache of `--cache-dir`. Errors:
exit 2 when not logged in (kind `login`), without `--project` (kind `usage`), with `--cache-dir` on another command or
empty (kind `usage`), when the history cache cannot be written in `--cache-dir` (a file, or no permission; kind
`usage`, the message names the directory: give a writable one), or when the project is not on Taiga or not visible to
the user (kind `project`; unlike `report`, which exits 5); exit 4 when `project.yaml` is invalid (its issues, as
`validate` reports them); exit 5 when Taiga refuses the login or a read, or cannot be reached (kind `taiga`).

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
they are, so a text that starts with `-` goes there (`comment --project vigo-auth 84 -- -x was the cause`), and so
does a text spanning lines when passed as one argument. `projects --project <slug>` lists
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
Application id exits 5 and stores nothing. `taigent setup` runs the same flow (without `--application`) when there is
no login and it has a terminal ([Setup: login and checks](#setup-login-and-checks)).

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
process, on stdin/stdout, for the `taiga` entries `taigent setup` writes (user configs, or `.mcp.json` / `.codex/config.toml` with `--project`); it exits when the agent closes stdin. Nothing goes
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
(Codex reads it) and a byte-identical copy in `.claude/skills/` (Claude Code reads it). Neither carries a version:
`taigent setup` stamps its own into each copy it installs elsewhere
([Setup: skill versions and duplicates](#setup-skill-versions-and-duplicates)). Edit only the `.agents/skills/` copy,
then copy:

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
| `taiga-setup` | Model or user | Checks, in order, `npx --no -- taigent --help`, the login (`taigent whoami`; the fix is the user running `npx taigent login` in their own terminal), the Taiga MCP server (`listProjects`, then `claude mcp get taiga` for its approval state), the skill version and duplicates (`outdatedSkills` and `duplicates` of `taigent setup --dry-run --json`); names each fix (mostly running `taigent setup` again for the skills and the user-scope `taiga` entries, or `npx taigent setup --project` for a project's; an entry by hand; running `taigent mcp`, once the user agrees; a fix table per client for the user scope), and installs Taigent on request (`taigent setup`, or `taigent setup --project` into a project) |
| `prd-to-taiga` | User only (as below) | PRD (`gh issue view` of a GitHub issue, a file or pasted text) → numbers its user stories US1, US2, … → `taiga-plan-backlog` (each story's `spec:` a link developers can open, a `# USn` comment above it) → summary table Key / Story / Epic / Tasks / PRD plus the uncovered user stories → asks whether to write `taiga/<slug>/preview.md` and `.preview/base.md` (`taigent preview --out`) for the BA to edit before `taiga-apply-backlog`. Writes files only |
| `taiga-plan-backlog` | Model or user (`/taiga-plan-backlog`, Codex `$taiga-plan-backlog`, `policy.allow_implicit_invocation: true`) | Spec/PRD → reads what exists (`taigent snapshot`, `taigent plan --json`, read-only on Taiga) → adopts the hand-made items the spec touches, each after a yes (`taigent adopt`), and settles blocked items (`taigent pull`) → edits `taiga/<slug>/backlog.yaml` in place (keeps keys) → answers the open comments of `review.yaml` (`taigent review resolve`, never verdicts; `taigent preview` offline), ends with `taigent validate`. Writes files only |
| `taiga-review-backlog` | User only (as below) | The BA/PO's review: `taigent preview` → records only the verdicts and comments the reviewer states for each item (`taigent review approve\|request-changes\|comment`) → `taigent validate`. Never decides a verdict, never resolves a comment. Offline, writes `review.yaml` only |
| `taiga-apply-backlog` | User only: `disable-model-invocation: true` (Claude), `policy.allow_implicit_invocation: false` in `agents/openai.yaml` (Codex) | When `taiga/<slug>/preview.md` exists (a `taigent preview` the BA edited, beside its untouched copy `.preview/base.md`): `git diff --no-index` of the two → writes the edits into `backlog.yaml` → `taigent validate` → refreshes both copies. Then `taigent plan` → shows it → asks → `taigent apply --yes` after an explicit yes |
| `taiga-create-user-story` | User only (as above) | One user story in the conventions §6.1 format under an existing epic, from the manifest or hand-made (adopted with `taigent adopt` after a yes): drafts it, checks for duplicates (manifest, `taigent snapshot`), adds it to `backlog.yaml`, `taigent validate` → `taigent plan --json` → asks → `taigent apply --yes`; hands over to `taiga-plan-backlog` when no epic fits and to `taiga-apply-backlog` when the plan holds other changes. Creates no epic or task |
| `taiga-bootstrap-project` | User only (as above) | Writes or checks `taiga/<slug>/project.yaml`, `taigent validate` → `taigent bootstrap --dry-run` → asks → `taigent bootstrap --yes` |
| `taiga-upload-docs` | User only (as above) | Updates `taiga/<slug>/docs.yaml` (referencing documents where they already are, no copies), `taigent validate` → `taigent upload --dry-run` → asks → `taigent upload --yes` |
| `taiga-status-report` | Model or user | Read-only report by sprint and by epic, or one quick count/lookup, through Taiga MCP read tools only (`listMilestones`, `getMilestone`, `getMilestoneStats`, `listEpics`, `listUserStories`, `getUserStory`, `advancedSearch`); hands questions about your own tickets to `taiga-my-tickets` |
| `taiga-my-tickets` | Model or user | Read-only report of your tickets in a period (the current week, Monday to Sunday, by default): `taigent tickets --json`, the one shell command it runs, laid out as header, summary, by day, by project, still open, notes, in the user's language |
| `taiga-update-ticket` | Model or user (`policy.allow_implicit_invocation: true`) | Finds the tickets a request names (`taigent tickets --json`; "close them" = the end-of-day reminder's list), then `taigent status` / `taigent comment` per ticket, at once, and reports each outcome |
| `taiga-dashboard` | Model or user (`policy.allow_implicit_invocation: true`) | Read-only **Dashboard** of one project for the user's **Role** (Developer, Product Owner or Business Analyst; asked when the request names none, never stored): `taigent metrics --json`, the one shell command it runs, with that role's metrics first, in glossary terms and the user's language |

Their `allowed-tools` pre-approve only `npx taigent validate|preview|plan|apply|bootstrap|upload|tickets|status|comment|snapshot|adopt|pull|metrics`
and `npx taigent review approve|request-changes|comment|resolve` (as
`Bash(...)` and, for Claude Code's Windows PowerShell tool, `PowerShell(...)` rules), Taiga MCP read tools, `gh issue view`
and `Skill(...)` of another Taigent skill (`prd-to-taiga` reads the PRD issue and runs `taiga-plan-backlog`); every
skill that pre-approves a plan-gated writing command (`apply`, `bootstrap`, `upload`) is user-only on both agents, and
so is `taiga-review-backlog`, the one skill that pre-approves `review approve` and `review request-changes` (a verdict
is the reviewer's decision; `taiga-plan-backlog` has only `review resolve`, and the headless allowlist no `review`
command) (`test/skills.test.ts` enforces these rules). They grant, not restrict: the gate before `--yes` is the skill's explicit
confirmation step. `status` and `comment` edit one of the user's own tickets that the request names, so
`taiga-update-ticket` runs on its own.
Codex's skill docs do not document `allowed-tools`; there, approvals come from `.codex/config.toml`, the sandbox, the
execpolicy rule `.codex/rules/taigent.rules` and, in headless runs, the shell hook `.codex/hooks/taigent-shell-guard.mjs`
(`docs/headless.md`).

### Installing for the user

The CLI skills run `npx taigent`, which runs the taigent a project pins (its `node_modules`), else the global one, so
after a global install they work in any directory, a project without `package.json` included. One machine needs:

```sh
npm i -g taigent                          # the CLI and the docs the skills cite, already built
taigent setup                             # in your own terminal: the skills and the taiga MCP server for every client
                                          # in your home directory, the login when you have none, then both checked
```

`taigent setup [--dry-run] [--json]` finds each client in the home directory (`os.homedir()`: `HOME`, on Windows
`USERPROFILE`) and installs into its user config, from the running taigent:

| Client | Found by | Skills | MCP server `taiga` | Sources |
|---|---|---|---|---|
| Claude Code | `~/.claude/` or `~/.claude.json` | `~/.claude/skills/<skill>/` | top-level `mcpServers.taiga` of `~/.claude.json`, where `claude mcp add -s user` writes | [skills](https://code.claude.com/docs/en/skills) (the "Personal" location, `~/.claude/skills/<skill-name>/SKILL.md`), [MCP scopes](https://code.claude.com/docs/en/mcp) ("User-scoped servers are stored in `~/.claude.json`"), [`.claude` directory](https://code.claude.com/docs/en/claude-directory) |
| Codex | `~/.codex/` | `~/.agents/skills/<skill>/` | `[mcp_servers.taiga]` of `~/.codex/config.toml` | [skills](https://learn.chatgpt.com/docs/build-skills) (the "USER" location, `$HOME/.agents/skills`), [MCP](https://learn.chatgpt.com/docs/extend/mcp) ("By default this is `~/.codex/config.toml`"), [config](https://learn.chatgpt.com/docs/config-file/config-basic) |
| OMP | `~/.omp/` | `~/.agents/skills/<skill>/`, which OMP reads by default: no second copy | `mcpServers.taiga` of `~/.omp/agent/mcp.json` | [skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md) (the `agents` provider), [MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md) ("User: `~/.omp/agent/mcp.json`"), [settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md) (other clients' user configs are off by default) |

The JSON entry is `{ "type": "stdio", "command": "taigent", "args": ["mcp"] }`; the Codex table runs the same
command with the `env_vars` of the project entry but not its `required = true`: the user config applies to every Codex
session, and a missing login or a Taiga outage must not stop Codex from starting anywhere (a project that pins taigent
keeps `required`). On Windows, where npm installs `taigent` as a `.cmd` shim that a client cannot start without a shell,
the command is `cmd` with `["/c", "taigent", "mcp"]`, for all three clients. Both are the user-scope entries of
`taiga-setup` and hold no secrets: `taigent mcp` uses the stored login. Setup reads only the home directory: it does not
follow `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CONFIG_DIR`.

A client it does not find is skipped, with the reason, and nothing is created for it (`~/.agents/skills/` is written
when Codex or OMP is found); with none found it writes nothing and says so (exit 0). Taigent skills are replaced or removed as with `setup --project`; other skills, servers
and keys stay: the JSON files are merged by key and keep their indentation (`~/.claude.json` holds the rest of Claude
Code's state; `~/.omp/agent/mcp.json` its `disabledServers`/`enabledServers`), and the Codex table is replaced in place
or appended. Every file is merged before the first write: one that is not valid JSON or TOML is exit 2 and nothing is
written. Running it again finds every file `unchanged`. `--dry-run` writes nothing and exits 3 when a file would change.
`--json` prints `{ "files": [{ "path", "status" }], "clients": [...], "login": {...}, "mcp": {...}, "taigentVersion",
"outdatedSkills": [...], "duplicates": [...] }`, the paths shown as `~/...`, with one client per known client in a
fixed order: `{ "name": "claude-code" | "codex" | "omp", "status": "configured", "skills", "mcp" }` (its skills
directory and MCP config) or `{ "name", "status": "skipped", "reason" }`; `login` and `mcp` are the steps that follow
the files ([Setup: login and checks](#setup-login-and-checks)), the last three what setup found installed
([Setup: skill versions and duplicates](#setup-skill-versions-and-duplicates)). The text form lists the clients, then
the files that change, then each step, the older skills and the duplicates. Agents load skills and MCP servers when
they start: restart them afterwards.

A project that also installs Taigent (`setup --project`) has a second copy of each skill and server: setup reports
them as `duplicates`, with the copy each client uses.

### Setup: login and checks

`taigent setup` and `taigent setup --project` write their files first (all or nothing, as above), then bring the
machine to a working state, in this order:

1. **Login.** The credentials are those of every command ([Credentials and environment](#credentials-and-environment)):
   `TAIGA_TOKEN` or `TAIGA_USERNAME` + `TAIGA_PASSWORD` (`environment`), else the login of `taigent login`
   (`stored`: its `login.json` exists), else none (`missing`). With none and a terminal (stdin and stdout), setup runs
   the [`taigent login`](#login-and-the-mcp-server) flow itself: same prompts, same stored token, the password typed
   in the terminal and never stored. Without a terminal (an agent, a pipe, CI) it reads no password from anywhere: it
   says to run `taigent login` in your own terminal, then `taigent setup` again, skips both checks and exits 0, since
   the files are installed.
2. **Login check**, as [`whoami`](#login-and-the-mcp-server): `GET /users/me` with those credentials.
3. **MCP check**: setup starts the `taiga` entry it wrote, as a client would: its command and arguments, without a
   shell (the `cmd /c` of a Windows entry is its own), with setup's environment, from the working directory (the
   project root for `--project`, whose entry is relative to it). It speaks MCP to it on stdin/stdout like an agent
   (`initialize`, then the read tool `listProjects`) and closes it. A list of projects, or the server's "No projects
   found." for a user in none, is a result; an error result, an MCP error, the server exiting first or no answer within
   60 s is a failure. The pinned `taiga-mcp-server` reads the projects page by page and reports a page it could not
   read as no projects, so a count of 0 is not proof that Taiga listed them. A command that is not on PATH (`taigent`
   after `npx taigent setup` without `npm i -g taigent`) fails the check with that fix, exit 2: nothing reached Taiga.
   With `--project`, before `npm install` there is no `node_modules/taigent` to start: the check is `skipped` with
   the fix (`npm install`, then `npx taigent setup --project` again), exit 0, since setup never runs `npm install`.

A failed step skips the steps after it and is named on stderr (`taigent: setup: the login check failed: …`,
`… the MCP check failed: …`) and in the report. Taiga refusing the credentials (or a stored login it no longer
renews), Taiga unreachable and a failed MCP check exit 5; a credential store setup cannot open, `TAIGA_API_URL` naming
another Taiga than the stored login, credentials inside `TAIGA_API_URL` or a server command not on PATH exit 2, the
message saying what to fix. When the OS credential store is unusable (e.g. Linux without a desktop session), the
message says to set `TAIGENT_CREDENTIAL_STORE=file`. Cancelling the login prompts exits 2. `--dry-run` neither logs in
nor runs a check: both steps are `skipped`, and nothing reaches Taiga.

With `--json`, the report gets:

- `login`: `{ "source": "stored" | "environment" | "missing", "status": "ok", "apiUrl", "user": { "id",
  "username" } }`, `{ "source", "status": "failed", "error" }`, or `{ "source", "status": "skipped", "reason" }`
  (no login without a terminal, or a dry run). After setup logged you in, `source` is `stored`; a login it could not
  complete is `missing` and `failed`;
- `mcp`: `{ "status": "ok", "projects": <count> }`, `{ "status": "failed", "error" }`, or `{ "status": "skipped",
  "reason" }`.

The text form prints one line per step (`Login: …`, `MCP server: …`, or `… check failed: …`), then the next step
when nothing failed (restart your agents; with `--project`, `npm install` first). Setup never approves an MCP server
for a client and never runs `npm install`.

### Setup: skill versions and duplicates

Every skill `taigent setup` and `taigent setup --project` install carries the version of the taigent that installed
it, as an entry of the frontmatter's [Agent Skills](https://agentskills.io/specification) `metadata` ("a map from
string keys to string values"), quoted since it must be a string:

```yaml
metadata:
  taigent-version: "0.1.0"
```

The sources in `.agents/skills/` and their `.claude/skills/` copies carry none (`test/skills.test.ts` checks it), so
`skills sync` and `skills check` are unchanged. Setup adds the entry at the end of each `SKILL.md` frontmatter (first
in an existing `metadata` map) as it copies the skill, and compares an installed copy with that stamped text: running
setup again finds it `unchanged`, a project's two copies stay identical, and a skill another taigent installed (or one
from before versions) is `updated`.

After its files (in a dry run too, as they are on disk), setup reports for both scopes, whichever it installed, and
never removes anything nor changes its exit code for them:

- `taigentVersion`: the running taigent's version.
- `outdatedSkills`: `[{ "scope": "user" | "project", "path", "version" }]`, each installed Taigent skill whose
  `metadata.taigent-version` is older than `taigentVersion` by semver precedence, or missing (`version`: null). It
  looks in the skills directories of the clients found in the home directory (`~/.claude/skills/`,
  `~/.agents/skills/`) and in `.agents/skills/` and `.claude/skills/` of the working directory (not in taigent's own
  repository, where those are the sources, nor when the working directory is the home directory). A newer skill is not
  listed. The fix is running setup again: `taigent setup` for `user`, `taigent setup --project` at the project root for
  `project`; the text form prints one line per skills directory, naming that command.
- `duplicates`: `[{ "kind": "skill" | "mcp", "name", "client", "user", "project", "winner", "rule" }]`, each Taigent
  skill and the `taiga` server present both in the home directory and in the working directory, once per client found
  in the home directory (none when the working directory is the home directory). `user` is the user copy (a skill
  directory such as `~/.claude/skills/taiga-setup`, or an MCP config such as `~/.claude.json`), `project` the project
  copy the client reads first, `winner` the copy it uses (`user`, `project`, or `both` when it shows both) and `rule`
  the client's rule in one sentence. The text form prints them grouped by client, kind and pair of places.

Which copy each client uses, by its documentation (fetched 2026-11-21):

| Client | Skills: user ↔ project | Winner | MCP `taiga`: user ↔ project | Winner |
|---|---|---|---|---|
| Claude Code | `~/.claude/skills/` ↔ `.claude/skills/` | `user`: "personal over project" ([skills](https://code.claude.com/docs/en/skills)) | `~/.claude.json` ↔ `.mcp.json` | `project`: "1. Local scope 2. Project scope 3. User scope", once the project server is approved ([MCP](https://code.claude.com/docs/en/mcp)) |
| Codex | `~/.agents/skills/` ↔ `.agents/skills/` | `both`: "Codex doesn't merge them; both can appear in skill selectors" ([skills](https://learn.chatgpt.com/docs/build-skills)) | `~/.codex/config.toml` ↔ `.codex/config.toml` | `project`: project config files, "closest wins; trusted projects only", before the user config; an untrusted project's `.codex/` is skipped ([config](https://learn.chatgpt.com/docs/config-file/config-advanced), [MCP](https://learn.chatgpt.com/docs/extend/mcp)) |
| OMP | `~/.agents/skills/` ↔ `.claude/skills/`, else `.agents/skills/` | `project`: the `claude` provider (priority 80) over `agents` (70); between project and user `.agents` roots, project first (documented for commands, assumed for skills); "every other variant receives a `<namespace>/<name>` suffix" ([skills](https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md)) | `~/.omp/agent/mcp.json` ↔ the first of `.omp/mcp.json`, `.omp/.mcp.json`, `.mcp.json`, `.codex/config.toml` | `project` for `.omp/mcp.json` or `.omp/.mcp.json` ("project `.omp/mcp.json` precedes `.omp/.mcp.json`, then the active profile's user `mcp.json`"); else `user`: OMP's native config comes before the Claude Code and Codex providers ([MCP](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md)) |

Not looked at: Claude Code's local-scope servers (`projects` of `~/.claude.json`, above both), OMP's native
`~/.omp/agent/skills/`, and skills or configs in the working directory's parents. `taiga-setup` (checks 4 and 5)
reads both lists from `setup --dry-run --json` and gives each client's fix.

### Using the skills in another project

A project can install Taigent for its whole team: each member then needs only `npm install` and a login. At its root:

```sh
npm i -g taigent                          # the CLI and the docs the skills cite, already built
npx taigent setup --project               # the skills, the MCP entries, the headless kit; pins taigent to its version
npm install                               # installs the pinned version
```

`taigent setup --project [--dry-run] [--json]` installs into the repository at the working directory everything Taigent needs,
taken from the running taigent:

| Writes | What |
|---|---|
| `.agents/skills/<skill>/`, `.claude/skills/<skill>/` | The Taigent skills (`taiga-*`, `prd-to-taiga`, `ask-taigent`), each `SKILL.md` stamped with the running version ([Setup: skill versions and duplicates](#setup-skill-versions-and-duplicates)). A Taigent skill that differs is replaced; one the running taigent does not ship is removed |
| `mcpServers.taiga` of `.mcp.json`, `[mcp_servers.taiga]` of `.codex/config.toml` | The Taiga MCP server, `node node_modules/taigent/bin/taigent.js mcp`: the entries of `taiga-setup`, no secrets |
| `tools/taiga/allowlist.txt`, `tools/taiga/omp-guard.mjs`, `.codex/hooks/taigent-shell-guard.mjs`, `.codex/rules/taigent.rules` | The headless kit, where `run-skill`, the OMP guard and the Codex shell guard look for it ([docs/headless.md](headless.md)) |
| `devDependencies.taigent` of `package.json` | `<version>`, the npm version of the running taigent, pinned exactly (moved out of `dependencies`). A missing `package.json` is created |
| `.gitignore` | `taiga/*/preview.md` and `taiga/*/.preview/` (the BA preview working copies) and `taiga/*/snapshot.json` (the snapshot of [`snapshot`](#snapshot)), never committed, appended under a `# Taigent:` comment when missing: an older install gets the lines it lacks, never a second copy. A missing `.gitignore` is created |

Running it again is safe. Other skills, MCP servers, keys, ignore lines and dependencies stay as they are: `.mcp.json` and
`package.json` are merged by key and keep their indentation, and `.codex/config.toml` gets its `[mcp_servers.taiga]`
table (subtables included) replaced in place or appended, every other line untouched. Every file is merged before the
first write: a file that is not valid JSON or TOML, or defines `mcp_servers.taiga` other than as a table, is exit 2
and nothing is written (so is running it in taigent's own repository). It never runs `npm install`. `--dry-run` writes
nothing and exits 3 when a file would change. `--json` prints `{ "files": [{ "path", "status" }], "login": {...},
"mcp": {...}, "taigentVersion", "outdatedSkills": [...], "duplicates": [...] }`, every file sorted by path, with
`status` one of `created`, `updated`, `unchanged` and `removed` (a file of a Taigent skill the running taigent does
not have); the text form lists the files that change. Then it logs in, checks and reports like `setup`
([Setup: login and checks](#setup-login-and-checks)); its MCP check starts the entry it wrote,
`node node_modules/taigent/bin/taigent.js mcp` from the project root, so before `npm install` it is not run (`skipped`,
exit 0) and says to run `npm install`, then `npx taigent setup --project` again.

The pin is the running version as published on npm (`0.1.0` for 0.1.0; see [Releasing](#releasing)). The published package
holds `dist/`, compiled from `src/` by the `prepack` script (`tsconfig.build.json`), so installing it compiles nothing:
under `node_modules` Node strips no types, so `bin/taigent.js` runs `dist/` there and the TypeScript sources
everywhere else. The package (`files` in `package.json`) ships `bin/`, `dist/`, `docs/cli.md`, `docs/headless.md`,
`docs/taiga/` and `docs/telegram-reply.md` (the docs the skills and `run-skill` cite, read from
`node_modules/taigent/`) and what `setup --project` installs: the Taigent skills of `.agents/skills/`, `tools/taiga/` (with
`run-skill`), the Codex hook and rule. `test/package.test.ts` checks the `npm pack` file list against what
`setup --project` copies and the docs the shipped skills and kit cite.
`setup --project` never approves the MCP server. Each user runs `npx taigent login` once, in their own terminal (whoever
runs `setup --project` in a terminal without a login is logged in by it), at the project root; the project commits the
files `setup --project` wrote and each user approves the project server once.
`taiga-status-report` needs only the Taiga MCP server; `taiga-my-tickets`, `taiga-update-ticket` and `taiga-dashboard`
need only the CLI (`taigent tickets`, `status`, `comment`, `metrics`). For chats from Telegram, also add the six `tickets|status|comment` rules of
the README's step 6e to the project's `.claude/settings.json`.
To run a skill without interaction, run `node_modules/taigent/tools/taiga/run-skill.ps1` (or `run-skill.sh`) from the
project root: it uses the project's skills and the allowlist `setup --project` installed ([docs/headless.md](headless.md)).
`npx skills add sondoquang/taigent` still installs the skills alone (no MCP entries, kit or pin). The `taiga-setup`
skill checks all of it and names each fix.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; nothing left to change (`setup` without a login and without a terminal: files installed, checks skipped) |
| 1 | Internal error (bug) |
| 2 | Usage or configuration error: unknown command/flag, a flag on a command that does not take it (e.g. `--epic`, `--story`, `--ref` or `--keep-manifest` elsewhere than `adopt`/`pull`), missing env var, not logged in, `TAIGA_API_URL` naming another Taiga than the stored login, `login` without a terminal or cancelled, unreadable credential store, unreadable `.env`, credentials in `TAIGA_API_URL`, `apply`/`bootstrap`/`upload` with changes but no `--yes`, `adopt` refusals ([Adopt](#adopt): closed or already tagged item, unknown ref, key or ref taken, missing or wrong parent, a story whose Taiga epics do not include `--epic`), `pull --key` naming an item not in `backlog.yaml` or not on Taiga yet, `backlog.yaml` changed while adopting or pulling (kind `usage`), `tickets` or `sprint create` without valid `--from`/`--to`, `--from`/`--to` with another command, `sprint create`/`sprint add` with changes but no `--yes`, `sprint create` on a name taken with other days, `sprint add` with an unknown sprint name or a ref that is no user story of the project, `--out` with another command than `preview`, `skills` outside a repository root, `status`/`comment` on a ref that is not one of your tickets or with an unknown status, `review` refusals, nothing written ([Review](#review): a key not in `backlog.yaml`, a comment id the item lacks, a missing or unknown subcommand, a malformed key, text after `approve`, a missing text or reply), `notify` without a bot token or a single chat, `setup` on a client config (`~/.claude.json`, `~/.codex/config.toml`, `~/.omp/agent/mcp.json`) it cannot merge or whose `taiga` server command is not on PATH (`taigent` after `npx taigent setup`), `setup --project` with a value, on a `.mcp.json`, `.codex/config.toml` or `package.json` it cannot merge, or in taigent's own repository, `metrics` of a project that is not on Taiga or not visible to the user |
| 3 | `plan` or `--dry-run` found changes (`setup --dry-run`, `setup --project --dry-run`: a file would change); `skills check` found differing copies |
| 4 | Manifest (or `review.yaml`) invalid or missing (including a new story without `use_case`/`scenarios`, or an issue type, severity or priority the project does not define, found by `plan`/`apply` after reading Taiga); `pull`: Taiga's values do not fit the manifest (kind `pull`, [Pull](#pull)), no file written; nothing was written to Taiga |
| 5 | Taiga or network error: HTTP error, unreachable host, login refused, stored login expired or revoked, unknown Application, unknown project (except for `metrics`: exit 2), version conflict, custom attribute name not defined on the project; bootstrap refusals (not admin, unknown role/template, slug mismatch); the Telegram Bot API refusing a `notify` message or unreachable; `setup`'s login check or MCP check failed ([Setup: login and checks](#setup-login-and-checks)) |
| 6 | `plan`/`apply` found blocked items: changed on Taiga since taigent last wrote or adopted them, or recorded in `state.json` but without their `src:<key>` tag on Taiga (`remote-edit`), changed on both sides differently (`both-edited`) or without a baseline and different from the manifest (`unknown`); see [Baseline and remote edits](#baseline-and-remote-edits). `apply --yes` wrote nothing, not even `state.json` |

## Code map

| Module | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | argv parsing, wiring, output, exit codes (`src/exit-codes.ts`); one review gate (`reviewGate`) and one text form for every plan and report |
| Manifest | `src/manifest/` | `loadManifests`/`MANIFESTS` registry (`manifests.ts`), `loadBacklog` (and `checkBacklog(doc, path)`, the same rules on an already parsed document), `loadDocs`, conventions rules (`conventions.ts`), `readManifestYaml`, `projectLayout`, `readState`/`writeState`, `ManifestError` |
| Items | `src/items.ts` | `ITEM_TYPES`/`ItemType` (`epic`, `story`, `task`, `issue`): the one item vocabulary outside the client; `ISSUE_VALUE_FIELDS` (`type`, `severity`, `priority`) |
| Secrets | `src/secrets.ts` | `Secrets` (`add`, `redact`): what no output may show, shared by the CLI (environment, typed password), the client and the stored login (tokens) and the MCP proxy |
| Login | `src/login.ts`, `src/prompt.ts` | `storeLogin`, `removeLogin`, `StoredSession` (a `TaigaAuthorizer`: the stored token, renewed under `login.lock`), `configDir`, the credential stores (`@napi-rs/keyring`, or a 0600 file); terminal-only prompts |
| MCP | `src/mcp.ts` | `startProxy` (the 127.0.0.1 proxy in front of Taiga for `taiga-mcp-server`), `serveMcp` (loads the server in-process with its `TAIGA_*` set), `checkMcp` (setup's MCP check: spawns the `taiga` entry setup wrote, without a shell, and calls `listProjects` over JSON-RPC; `McpStartError` when its command is not on PATH, exit 2; `McpCheckError`, exit 5) |
| Operations | `src/operations.ts` | the shape every plan/execute command shares: `Action` → `RESULT`, `summarize(actions, operations)` → `{ changes, summary }`, `tally` for reports, `FILL_ACTIONS` (bootstrap, upload) |
| Taiga client | `src/taiga/client.ts` | `TaigaClient` (all HTTP, `x-disable-pagination`, PATCH with `version`; item methods keyed by `ItemType`: `listItems`/`createItem`/`updateItem`, `getAttributeValues`/`updateAttributeValues`, `listAttachments`/`uploadAttachment`, `listStatuses(type, projectId)`; `listIssueValues(field, projectId)` for an issue's type, severity and priority; `listAssignedStories` for `tickets`, `editStory` for `status` and `comment`; `listMemberProjects(userId)` for `projects`; `listStories`, `listMilestones`, `getMilestoneStats` for `report`, and `listProjectTasks` for `metrics`; `login`/`refresh` token pairs, `createApplicationToken`/`deleteApplicationTokens`; a `TaigaAuthorizer` option for the stored login), the only place that maps item types and issue value fields to Taiga's endpoint and field names (`TAIGA_ITEM`, `TAIGA_ISSUE_VALUES`), `TaigaError`, `TaigaAuthError` (`credential`: `token`, `password` or `login`), `TaigaConflictError` (OCC refusal; `key` set by the command that planned the write) |
| Remote reader | `src/remote.ts` | `readBacklogRemote(backlog, client, slug)`: reads the project, its items, epic links (of epics tagged `src:` or adopted by `ref`), issue values (when the backlog has issues) and attribute values `buildPlan` needs |
| Managed values | `src/managed.ts` | pure `manifestManagedValues(entry)` and `remoteManagedValues(type, item, remote, attributes, backlogKey)` → `ManagedValues` (plain JSON, also the baseline stored in `state.json`): the fields taigent owns on an item (subject, description, `type:`/`area:` tags, declared custom attributes, an issue's type/severity/priority names, a task's story key, a story's epic keys), projected the same way from the manifest and from Taiga (`backlogKey`, from `backlogKeyOf(backlog)`, resolves a Taiga item to its backlog key: its `src:` tag, else the backlog item naming its `ref`; shared by plan, preview and adopt); `snapshotManagedValues(type, item, manifest, baseline, backlogKey)` projects a `snapshot.json` item the same way (custom attributes taken from the baseline); `differingFields(manifest, remote)` (tags and epic links additive), `remoteEditedFields(baseline, remote, manifest)` (what changed on Taiga since the baseline), `blockedFields(manifest, remote, baseline)` → `{ kind: BlockedKind, fields }` or undefined (the three-way table of [Baseline and remote edits](#baseline-and-remote-edits), shared by `plan` and `preview`), `keyOf(item)`, `isSrcTag(tag)`, `managedTags(tags)`, `issueValueName(values, id)`. Status, assignee, sprint, points and unprefixed tags are outside the projection |
| Planner | `src/planner.ts` | pure `buildPlan(backlog, remote, state)` (`state`: `items` and `adopted` of `state.json`, whose baselines count via `recordedBaseline(entry, type, id)` of `src/manifest/state.ts`) → `{ plan, baselines, counterparts }` (operations `create`, `update`, `adopt`, `link`, `skip`, orphans, stale links, blocked items and `handMadeChildren`, plus the baseline apply records per key, adopted items included, and `counterparts`: the Taiga item each backlog item is or adopts (`adopting`) with both sides' managed values, for `pull`), or `RefMismatchError` naming the backlog items whose `ref` does not match Taiga (reported as `item-ref` issues of `backlog.yaml`), `LegacyStoryCreateError` naming the stories it would create in the legacy format (the CLI reports them as `story-format` issues of `backlog.yaml`), or `UnknownIssueValueError` naming the issue values the project does not define (reported as `issue-value` issues), `describePlanOperation`, `srcTag(key)` |
| Adopt | `src/adopt.ts` | `adoptItem(dir, slug, client, { ref, key, parent? })` → `AdoptResult` (writes `backlog.yaml` through `saveItem` and the copied Taiga values under `adopted` in `state.json`, never Taiga), `AdoptError` (exit 2), `ManifestChangedError` (exit 2, from `src/backlog-write.ts`): the `adopt` command; one case per item type in `backlogItem`, `parent` (`{ type: 'epic' \| 'story', key }`) required for a story and a task |
| Pull | `src/pull.ts` | `pullItems(layout, backlog, planned, { key?, keepManifest, baseDigest })` → `PullReport` (writes `backlog.yaml` through `saveItems`, refused when it changed since `baseDigest`, read before Taiga, and the baselines of `state.json`, never Taiga), `PullError` (exit 4, kind `pull`), `PullKeyError` and `ManifestChangedError` (exit 2): the `pull` command |
| Story template | `src/story-template.ts` | pure `storyDescription(story)`: the description apply writes for a story, shared by the planner and `preview`; pure `parseStoryDescription(text, format)`, its inverse for `pull` (undefined unless the parse renders `text` again exactly) |
| Review | `src/review.ts` | `loadReview(path)`/`saveReview`, pure `setVerdict`/`addComment`/`resolveComment`, `recordReview(dir, slug, action)` (the `review` command: the one way the CLI writes `review.yaml`), `itemDigest`, `buildPreview(dir, slug)` → `Preview` (epic tree + `issues`, with the adopt and remote badges of `snapshot.json`; review entries of keys the backlog lacks in `summary.unknownReviewKeys`), `previewItems(preview)` (every item in manifest order; also the metrics' awaiting review and pending clarification), `renderPreviewMarkdown`: the offline `preview` command |
| Backlog write | `src/backlog-write.ts` | how `adopt` and `pull` write `backlog.yaml`: `readBacklogFile(dir)` → `{ file, text, digest }` (SHA-256 of the file); `saveItem(dir, { baseDigest, edit?, item })` adds an epic/story/task/issue, or with `edit: true` edits the item `item.key` of its type (`item` = `{ type, key, parent?, fields }`, no `parent` for an issue, whose `fields` add `type`/`severity`/`priority`; a new parent moves the item with its children; a story's `useCase`/`scenarios` replace `acceptance_criteria` and the reverse); `saveItems(dir, { baseDigest, items: [{ edit?, item }] })` does the same for several items in one write, none when one is invalid (`paths`; `pull` uses it). Every write returns `SaveResult`: `saved` (new `digest`), `conflict` (backlog.yaml no longer has the digest given; `current` is the file now, nothing written) or `invalid` (`issues` with `path` + `rule`: the `checkBacklog` issues under a written item only, `key-unique` (`checkKey`, on a written item's key, issues included), `key-reference` for a missing item or parent). Writes go through yaml's Document API, so comments, order, quoting, flow style and line ends of untouched nodes stay; the writes of one process run one at a time (a digest check and its write never interleave), each atomic. review.yaml is never touched: an edited item's verdict turns stale through its digest. Where each item type sits and its field order is the `KINDS` table |
| Files | `src/files.ts` | `sha256(text)` (the digest a backlog write is checked against) and `writeAtomic(path, content)` / `temporaryPath(path)` (a unique `.<name>.<uuid>.tmp` beside the file, renamed over it): shared by the backlog writes, `saveReview`, `snapshot`, the metrics history cache and setup (e.g. `~/.claude.json`, which Claude Code rewrites while it runs) |
| Executor | `src/executor.ts` | `executePlan({ plan, baselines }, client, statePath, customAttributes)`, `describeAppliedOperation` |
| Bootstrap | `src/bootstrap.ts`, `src/manifest/project.ts` | `loadProject`; `readBootstrapRemote(manifest, client, statePath)`, pure `planBootstrap(manifest, remote)`, `executeBootstrap(plan, project, client, statePath)` |
| Upload | `src/upload.ts` | `readUploadRemote(docs, backlog, client, slug)` (reads Taiga, hashes files), pure `planUpload(docs, remote, cwd)`, `executeUpload(plan, client, cwd)`, `UploadTooLargeError` (carries `file`) |
| Skills | `src/skills.ts` | `compareSkills(root)`, `syncSkills(root)`: the Taigent skills (`taiga-*`, `prd-to-taiga`, `ask-taigent`), `.agents/skills/` → `.claude/skills/`; `compareSkillDirs(source, target, content?)` (file by file, `same` included) and `copySkills(source, target, comparison, content?)` for any two directories, a copy holding what `content` makes of each source file (setup: `stampSkillVersion`; `skillVersion` reads it back) |
| Setup | `src/setup.ts` | `setupUser(home, { dryRun })` and `setupProject(root, { dryRun })` → `SetupReport` (`files: [{ path, status }]`, `clients` for `setupUser`), `SetupError` (exit 2): the offline file part of `setup` and `setup --project` (`FilePlan` plans every file before the first write and writes each with `writeAtomic`, each skill stamped with the running version; `USER_CLIENTS` lists each client's label, marker, skills directory and MCP config, and how it ranks a project copy against them; `mcpServer` builds each scope's `taiga` entry, JSON and Codex table, from one command line), copying from the running package (`src/`'s parent: the repository, or `node_modules/taigent` when installed); `mcpCheckTarget(scope, root)` → the command line setup wrote and the fix when it cannot start, or why there is nothing to start yet; `checkInstall(home, cwd)` → `InstallCheck` (`taigentVersion`, `outdatedSkills`, `duplicates`). `runSetup` in `src/cli.ts` runs the files, `setupLogin` (`interactiveLogin`, as `taigent login`, then `whoami`), `setupMcpCheck` (`checkMcp`) and `checkInstall`, then prints the report |
| Tickets | `src/tickets.ts` | `dayRange(from, to)`, `readTickets(client, range, project?)` → `TicketsReport`, `formatTicketsText`: the read-only `tickets` command |
| Projects | `src/projects.ts` | `readProjects(client, manifestsRoot)` → `ProjectsReport`, `readProjectDetail(client, slug, manifestsRoot)` → `ProjectDetailReport` (issue values and `storyStatuses`), `formatProjectsText`, `formatProjectDetailText`: the read-only `projects` command |
| Report | `src/report.ts` | `readProjectReport(client, slug)` → `ProjectReport` (sprints, epics, `noEpic`, `outsideSprints`), `formatProjectReportText`: the read-only `report` command; the tables come from `readReportExtras` (sprint stats, epics and their stories, `TAIGA_CONCURRENCY` requests at a time) and the pure `reportTables(source)` → `ReportTables` / `formatReportTablesText`, which `metrics` reuses for `productOwner.report` |
| Snapshot | `src/snapshot.ts` | `readSnapshot(client, slug)` → `Snapshot` (GET only), `writeSnapshot(path, snapshot)`, `readSnapshotFile(path)` (undefined without one; `preview` reads it), `summarizeSnapshot`, `formatSnapshotText`: the read-only `snapshot` command; the file is `projectLayout(...).snapshot` (`SNAPSHOT_FILE` in `src/manifest/layout.ts`) |
| Metrics | `src/metrics/` | the read-only `metrics` command: `readSnapshot(client, slug, cacheDir?)` → `MetricsSnapshot`, all I/O (`snapshot.ts`; `ProjectNotFoundError`, exit 2), with `history`: each story's, task's and bug's `TaigaHistoryEntry[]` (status and sprint changes, whether the description changed, oldest first) read by `readHistories` (`history.ts`: `client.listHistory(type, id)`, 8 at a time and none started after one fails, and the `--cache-dir` file keyed by API URL, project, type and id, hit while the item's fingerprint (`modified_date`, status, sprint, closed flag and date: `fingerprint` in `snapshot.ts`) is unchanged, written with `writeAtomic`; `HistoryCacheError`, exit 2); `readReleases(dir, slug)` → the `releases` of project.yaml (`releases.ts`); `readBacklogData(dir, slug)` → `BacklogData` (`backlog.ts`: the `buildPreview` of the manifests, or why there is none: `missing`, `invalid` with the issues); pure `computeMetrics(snapshot, local, now)` → `MetricsReport` (`compute.ts`), which builds the `MetricsContext` (`context.ts`: local data `MetricsLocal`, periods, work items, `notes` for warnings and unavailable metrics) and calls one module per Role section (`developer.ts`, `bugs.ts` for `developer.bugs` and `productOwner.bugTrend`, `releases.ts` for `productOwner.releaseBurndown`, `product-owner.ts` for the rest of `productOwner`: current sprint, velocity, planned, scope change (`sprint-scope.ts`: each story's sprint over time from its sprint changes), health and `report`'s tables, `business-analyst.ts` for `businessAnalyst`); periods (`periods.ts`), work items closed by status flag, with the day they first entered In progress, and `historyStatusName`, how every metric names a status of a history (`work.ts`), `formatMetricsText` (`text.ts`, each section formats its own lines) |
| Days | `src/days.ts` | calendar days in local time: `parseDay`, `localDay`, `localMinute`, `addDays`, `daysBetween`, `mondayOf`, shared by `tickets`, `notify`, the manifests and `metrics` |
| Concurrency | `src/taiga/concurrency.ts` | `mapLimited(items, limit, read)` and `TAIGA_CONCURRENCY` (8): one read of Taiga per sprint, epic or item, a few at a time, none started after one fails (`report`, `metrics`) |
| Sprints | `src/sprint.ts` | `readSprints`/`formatSprintListText` (`sprint list`), `planSprintCreate`/`executeSprintCreate` (`POST /milestones`, idempotent by name and days), `planSprintAdd`/`executeSprintAdd` (story `milestone` via `editStory`, OCC), `SprintError` (exit 2) |
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

`npm test` (Node's built-in runner) and `npm run typecheck`. Tests go through the CLI seam, except a few library APIs,
each tested on a temporary directory: `storeLogin`, the review API of `src/review.ts` (`test/review.test.ts`) and the
backlog writes of `src/backlog-write.ts` (`test/backlog-write.test.ts`).
`test/support/harness.ts` (`startHarness(t)`) spawns `bin/taigent.js` in a temp working directory against
`test/support/fake-taiga.ts` (`startFakeTaiga()`), an in-process fake of the Taiga API that validates
payloads like Taiga (and additionally rejects unknown fields). Extend the fake rather than mocking modules. Every run
gets `TAIGENT_CONFIG_DIR` = `h.configDir` (in the temp directory) and `TAIGENT_CREDENTIAL_STORE=file`, so no test
touches the developer's stored login or OS credential store; `test/login.test.ts` stores a login with `storeLogin`
(what `taigent login` runs after its terminal prompts) and drives `taigent mcp` over MCP JSON-RPC on stdin/stdout.
Every run also gets `HOME` and `USERPROFILE` = `h.home`, an empty temp directory, so no test reads or writes the
developer's home; `test/setup-user.test.ts` puts client markers (`.claude/`, `.codex/`, `.omp/`) and configs there.
`test/setup-login.test.ts` covers setup's login and checks with a stored login, `TAIGA_*`, no login (no TTY), a
refused login, a failed MCP check, the user entry's `taigent` not on PATH, `--project` before `npm install` and
`--dry-run`; the MCP check starts the entry setup wrote, so those tests put a bin directory holding a `taigent` shim
(sh and `.cmd`, running this repository's `bin/taigent.js`) first on PATH and link `node_modules/taigent` in the
project to the repository. A test that runs `setup` with `runTaigent` directly (not through the harness) sets its own
`TAIGENT_CONFIG_DIR`, since setup looks for a stored login; `childEnv` (so `runTaigent` too) gives every run that sets
none a temp `HOME`, `USERPROFILE`, `APPDATA` and `XDG_CONFIG_HOME`, never the developer's. `test/setup-versions.test.ts`
covers the version stamped into every installed skill, `outdatedSkills` and `duplicates` with copies in both `h.home`
and `h.cwd`.

Fake API used by the tests (`FakeTaiga` in `test/support/fake-taiga.ts`):

- `fake.url` (TAIGA_API_URL, includes `/api/v1`) and `fake.user` (`{ id, username, password, email }`, the account
  `POST /auth` accepts; the harness logs in with it).
- Seeding: `addEpic`, `addUserStory`, `addTask` (`{ project, subject, description?, tags? }`, plus
  `user_story?` for tasks), `addIssue` (the same plus `type?`, `severity?`, `priority?`, `status?` ids; the project's
  defaults otherwise), `addEpicRelatedUserStory(epic, story)`, `addMilestone({ project, name, estimated_start,
  estimated_finish, closed? })` (a sprint: set `milestone` on stories and tasks to put them in it; `GET /milestones`
  embeds its stories and their summed `total_points`/`closed_points`, `GET /milestones/<id>/stats` counts its stories
  by `is_closed` and its tasks by `is_closed`; `POST /milestones` creates one like taiga-back, name unique per project, start not after finish,
  and a story PATCH with `milestone` must name a sprint of its project); bootstrap fixtures `addUser`, `addProject({ slug,
  name?, members?, admins?, is_private?, modules?, tagsColors? })` (`GET /projects?member=<user id>` lists the projects
  of that member the caller can see, like taiga-back's `member` filter, with `i_am_admin`), `addCustomAttribute`, `addMembership`,
  `addWikiPage`; upload fixtures `addAttachment({ project, objectType: "epics" | "userstories" | "tasks" | "wiki",
  object_id, name, content })`. History of stories, tasks and issues (`GET /history/{userstory|task|issue}/<id>`,
  newest first, entries shaped like taiga-back's HistoryEntrySerializer: `created_at`, `type: 1`, `key`, raw `diff`,
  `values`, `values_diff` with names): `addHistory(item, { at, diff?, values?, comment? })` and its helpers
  `addStatusChange(item, { at, from, to })` (status names of the item's project), `addMilestoneChange(item, { at, from,
  to })` (sprints or null) and `addDescriptionChange(item, { at, from, to })`; each moves the item's `modified_date` to
  `at` when later. For `tickets`, set the returned story's `assigned_users`, `is_closed`, `finish_date`,
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

## Releasing

`.github/workflows/publish.yml` publishes taigent to npm when a tag `v*` is pushed. It fails unless the tag is
`v<version>` of `package.json`, then runs `npm ci`, `npm run build`, `npm run typecheck`, `npm test` and
`npm publish --provenance` (Node 24, npm 11.5.1 or later). A release is:

```sh
npm version 0.2.0 -m "chore: release %s"   # bumps package.json and package-lock.json, commits, tags v0.2.0
git push --follow-tags
```

`npm pack --dry-run` lists what the tarball holds; `prepack` builds `dist/` first.

Human steps on npmjs.com, once (an agent cannot do them):

1. **First publish.** The package `taigent` does not exist on npm yet, and trusted publishing is set on an existing
   package's settings page. Publish the first version by hand from a clean checkout of the release tag
   (`npm login`, then `npm publish`; provenance needs CI, so this one has none), or create an npm granular access
   token with publish rights and store it as the repository secret `NPM_TOKEN` (Settings → Secrets and variables →
   Actions) before pushing the tag: the workflow passes it as `NODE_AUTH_TOKEN`.
2. **Trusted publisher.** On npmjs.com, Packages → `taigent` → Settings → Trusted publishing: choose GitHub Actions,
   organization or user `sondoquang`, repository `taigent`, workflow filename `publish.yml`. The first publish
   through it must succeed within 2 days or the configuration expires. Trusted publishing works only on
   GitHub-hosted runners, and provenance only from a public repository whose URL equals `repository.url` of
   `package.json` (`git+https://github.com/sondoquang/taigent.git`).
3. Once trusted publishing works, delete the `NPM_TOKEN` secret and revoke the token (if one was created), and on the
   package settings require two-factor authentication and disallow tokens.

# New user stories use the user story format (Mike Cohn + Gherkin); existing ones keep the legacy format

Every user story created from now on uses structured `use_case` (As a / I want to / so that) and `scenarios` (Scenario / Given / When / Then, one When and one Then per scenario) in the manifest. Labels stay in English and the content is written in the team's language. The 63 stories already on Taiga keep their old `description` "Là …, tôi muốn …, để …" and their checkbox `acceptance_criteria`, and an agent converts one only when asked: a rewrite of all of them was rejected because it would overwrite every description on Taiga and needs hand-written scenarios. The rule is enforced by `taigent plan` on create operations, because the `src:<key>` tag on Taiga is the source of truth. `taigent validate` could not enforce it offline: it would have to trust `state.json`, which is only a cache, and a missing or stale copy would mark old stories as new.

## Consequences

- The manifest schema carries two story formats for good. A story never mixes them; `validate` checks the shape of each format offline.
- The canonical format lives in `docs/taiga/conventions.md` §6, not in the third-party `user-story` skill, so projects without that skill still follow it.

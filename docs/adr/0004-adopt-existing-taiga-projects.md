# Existing Taiga projects: Taiga is the truth, hand-made items are adopted on demand, and a baseline detects remote edits

Taigent is used on projects whose epics, stories, tasks and issues were made by hand on Taiga, so the manifest is a draft of pending changes and Taiga stays the source of truth. A read-only snapshot of the project (every epic, every open story, task and issue, with full descriptions) is read for context before planning. A hand-made item is adopted only when a plan touches it (to edit it, to file a story under it, or because it duplicates planned work), item by item after the user confirms: its content is copied verbatim into a new backlog item, a free-text story keeps the legacy format, and the binding is the `src:<key>` tag written by `apply`, so the tag stays the only identity. To stop `apply` from silently reverting edits made on Taiga, `state.json` keeps a baseline of what Taigent last wrote for each item, and of what `adopt` copied for an item not applied yet. A remote edit blocks that item until the manifest takes Taiga's value. An item changed on both sides (both edited), or one without a baseline (unknown origin), is shown with every version and the user decides; nothing picks a winner silently. After seeing a remote edit, a both-edited or an unknown-origin item, the user may deliberately keep the manifest's value (`pull --keep-manifest`), so the next apply writes it to Taiga; that is never the default.

## Considered Options

- **Two-way sync with the manifest as the truth**: rejected, because it needs conflict rules for every field and overwrites the work of people who edit on Taiga.
- **Binding by id in `state.json`**: rejected. A lost or badly merged `state.json` would lose the binding, and the tag already plays that role (ADR 0001).
- **Adopting every open item up front**: rejected. It writes tags to hundreds of items nobody wants to change, and sends them all to review.

## Consequences

- `state.json` stays out of identity, but it now carries meaning beyond a cache: losing it turns every difference into a question for the user. It must be committed with the manifest, as before.
- The legacy format now also covers adopted free-text stories that never had a `src:` tag.
- An existing project's name and slug are exempt from the naming rules; those rules apply only when bootstrap creates a new project.

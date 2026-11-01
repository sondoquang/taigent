---
name: taiga-upload-docs
description: "Upload the wiki pages and attachments of a docs.yaml to Taiga, after a dry run you confirm."
disable-model-invocation: true
allowed-tools: Bash(npx taigent validate *) Bash(npx taigent upload *) PowerShell(npx taigent validate *) PowerShell(npx taigent upload *)
---

# Taiga upload docs

Bring a project's Taiga wiki pages and attachments to what `taiga/<slug>/docs.yaml` declares, in four moves: **manifest**, **dry run**, **confirm**, **upload**. The `taigent` CLI makes every write. It upserts wiki pages by slug, skips attachments already on Taiga with the same name and content, and never deletes, renames or edits an existing attachment.

Run each `npx taigent …` command exactly as written, alone in its own shell call from the repository root, and branch on its exit code (all codes: `docs/cli.md` §Exit codes).

## 1. Pick the project

The slug the user named. With exactly one directory under `taiga/`, use it; otherwise ask.

## 2. Update the manifest

Read `docs/cli.md` sections "Manifest layout" (the `docs.yaml` schema) and "Upload", and `docs/taiga/conventions.md` §8–§9 (wiki slugs, attachment names and targets). Then edit `taiga/<slug>/docs.yaml` in place, or create it, for the documents the user named. Keep every existing entry; removing one does not remove it from Taiga.

- **`file` paths** are relative to the directory of `docs.yaml` and may point anywhere in the repository, so list each document where it already lives (e.g. `../../docs/specs/auth.md`). `taigent` hashes and streams attachments from disk: leave binary files closed.
- **Wiki page**: `{ slug, file }`, where `file` is a Markdown (`.md`) file. The file is the page: edit the file, not Taiga. Write a new page under `taiga/<slug>/pages/`.
- **Attachment**: `{ target, file, description }`. The file's name is the attachment name on Taiga. When an existing file's name breaks the `attachment-name` rule, ask the user to copy it under a conforming name (by convention into `taiga/<slug>/files/`) and list the copy; a file already uploaded keeps its name.

Then run `npx taigent validate --project <slug>`. Exit 4 prints each problem as `file: path: message [rule]`; fix every one and run it again. Done when it exits 0.

## 3. Dry run

Run `npx taigent upload --project <slug> --dry-run`.

- **Exit 3**: there are changes. Go to step 4.
- **Exit 0**: Taiga already has every page and attachment. Say so and stop.
- **Exit 4**: fix the manifest (step 2).
- **Exit 5, `no <type> tagged src:<key> on Taiga yet`**: an attachment targets an item that `taigent apply` has not created yet. Suggest `/taiga-apply-backlog` (Codex: `$taiga-apply-backlog`) first, and stop. `wiki page "home" does not exist`: suggest `/taiga-bootstrap-project` with `wiki_home`.
- **Exit 2 or other exit 5**: show the error (missing variable, login refused, unknown project, Taiga unreachable) and stop.

## 4. Show the dry run and ask

Show the output exactly as printed: every `create`, `update` and `skip` line and the summary line. Point out wiki `update` lines (the page on Taiga gets the file's content) and attachments whose previous version stays on Taiga.

Then ask: "Upload these docs to Taiga project `<slug>`?" and end your turn. Go on only when the user explicitly confirms this dry run; any other reply ends the skill with Taiga untouched.

## 5. Upload

After the confirmation:

1. Run `npx taigent upload --project <slug> --dry-run` again. When its operations differ from the ones the user confirmed, show the new ones and return to step 4.
2. Run `npx taigent upload --project <slug> --yes`.

Done when it exits 0.

- **Exit 5, conflict**: someone edited a wiki page on Taiga meanwhile; nothing was overwritten. Show the message and return to step 3.
- **Exit 5, too large**: the server refused the named file. Uploads before it are kept. Suggest compressing or splitting the file, or raising the server's upload limit.
- **Other exit 5**: show the message. A re-run skips what was already uploaded.

## 6. Report

Report the summary line (created, updated, unchanged), list attachments whose previous version stays on Taiga (remove those by hand if obsolete), and remind the user to commit `docs.yaml` with its pages and files.

This skill reaches Taiga only through `npx taigent`, and writes only through `npx taigent upload --yes` after the user's confirmation (`docs/taiga/conventions.md` §10).

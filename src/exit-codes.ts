/** Process exit codes of the `taigent` CLI. Documented in docs/cli.md; scripts and skills rely on them. */
export const ExitCode = {
  /** Success; nothing left to change. */
  Ok: 0,
  /** Unexpected internal error (a bug). */
  Internal: 1,
  /** Bad usage or configuration: unknown command/flag, missing env var, `apply` without `--yes`. */
  Usage: 2,
  /** `plan` found changes that `apply` would make; `skills check` found Claude copies that `skills sync` would rewrite. */
  Changes: 3,
  /** A manifest is invalid. Nothing was sent to Taiga. */
  Validation: 4,
  /** Taiga or the network failed (HTTP error, unreachable host, login refused). */
  Taiga: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

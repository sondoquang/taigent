// Secrets that must never be printed: the credentials from the environment and every token the Taiga client
// obtains. The CLI passes every output (stdout, stderr, --json, internal error stacks) through `redact`.

export const REDACTED = '[redacted]';

export class Secrets {
  readonly #values = new Set<string>();

  add(value: string | undefined): void {
    if (value) this.#values.add(value);
  }

  redact(text: string): string {
    let result = text;
    // Longest first, so a secret containing another one is replaced whole.
    for (const secret of [...this.#values].sort((a, b) => b.length - a.length)) result = result.replaceAll(secret, REDACTED);
    return result;
  }
}

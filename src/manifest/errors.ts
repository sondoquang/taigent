/** One manifest problem: which file, where inside it (e.g. `epics[2].key`), which rule, and why. */
export interface ManifestIssue {
  file: string;
  path: string;
  rule: string;
  message: string;
}

/** Thrown when a manifest is missing or invalid. Maps to ExitCode.Validation. */
export class ManifestError extends Error {
  readonly issues: ManifestIssue[];

  constructor(issues: ManifestIssue[]) {
    super(
      issues
        .map((i) => `${i.file}${i.path ? `: ${i.path}` : ''}: ${i.message} [${i.rule}]`)
        .join('\n'),
    );
    this.name = 'ManifestError';
    this.issues = issues;
  }
}

/** The package's one canonical object guard for parsed YAML/JSON; fields stay `unknown` and must be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Message of anything thrown (non-Error throwables are stringified). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a filesystem "no such file or directory" error. */
export function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

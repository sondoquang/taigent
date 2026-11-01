/** The package's one canonical object guard for parsed YAML/JSON; fields stay `unknown` and must be checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

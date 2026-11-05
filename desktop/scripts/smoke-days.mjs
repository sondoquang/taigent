// Days relative to today, local time, for the fixtures of the Dashboard smoke steps (smoke-dashboard*.mjs).

const pad = (n) => String(n).padStart(2, '0');

/** The local day `offset` days from today, YYYY-MM-DD. */
export function day(offset) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Noon (local time) of the day `offset` days from today, ISO 8601. */
export function at(offset) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12).toISOString();
}

// Taiga conventions as code: the rules of docs/taiga/conventions.md that a manifest can be checked
// against offline. Every manifest loader (project, backlog, docs) reuses these checks so a rule lives in
// exactly one place. Each check reports through an IssueSink, the `issue(path, rule, message)` callback
// that a loader binds to its file; the rule ids are part of the CLI contract (JSON `issues[].rule`).

/** Reports one problem at `path` inside the manifest being loaded (e.g. `epics[0].tags[1]`). */
export type IssueSink = (path: string, rule: string, message: string) => void;

// ---- Project name and slug ----------------------------------------------------------------------

/** Separator between the two parts of a project name: `<Client/Area> - <Product>`. */
export const PROJECT_NAME_SEPARATOR = ' - ';

/** Example shown in messages and docs. */
const PROJECT_NAME_EXAMPLE = 'Vigo - Core Mapping';

/**
 * Taiga's slug for a project name (taiga-back `slugify`: transliterate to ASCII, lowercase, drop
 * punctuation, runs of spaces/dashes → `-`). `Vigo - Core Mapping` → `vigo-core-mapping`.
 */
export function projectSlug(name: string): string {
  return name
    .replace(/[đĐ]/g, 'd')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, '')
    .replace(/[-\s]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

/** Rule `project-name`: exactly two non-empty parts joined by ` - `, single spaces, no stray dashes. */
export function checkProjectName(name: unknown, at: string, issue: IssueSink): name is string {
  const parts = typeof name === 'string' ? name.split(PROJECT_NAME_SEPARATOR) : [];
  const valid =
    parts.length === 2 &&
    parts.every((part) => part !== '' && part === part.trim() && !/\s{2}/.test(part) && !/^-|-$/.test(part));
  if (!valid) {
    issue(at, 'project-name', `project name must be "<Client/Area> - <Product>", e.g. "${PROJECT_NAME_EXAMPLE}"`);
  }
  return valid;
}

/** Rule `project-slug`: the slug is the one Taiga derives from the name (see `projectSlug`). */
export function checkProjectSlug(slug: unknown, name: unknown, at: string, issue: IssueSink): void {
  if (typeof name !== 'string') {
    if (typeof slug !== 'string' || slug === '') issue(at, 'project-slug', 'slug is required');
    return;
  }
  const expected = projectSlug(name);
  if (slug !== expected) {
    issue(at, 'project-slug', `slug must be "${expected}" (derived from the project name "${name}")`);
  }
}

// ---- Template and modules -----------------------------------------------------------------------

export const PROJECT_TEMPLATES = ['scrum', 'kanban'] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

/** Rule `template`: one of the instance's templates. */
export function checkTemplate(template: unknown, at: string, issue: IssueSink): template is ProjectTemplate {
  const valid = PROJECT_TEMPLATES.includes(template as ProjectTemplate);
  if (!valid) issue(at, 'template', `template must be one of ${PROJECT_TEMPLATES.join(', ')}`);
  return valid;
}

/** Taiga project modules (`is_<module>_activated`). */
export const PROJECT_MODULES = ['epics', 'backlog', 'kanban', 'issues', 'wiki'] as const;
export type ProjectModule = (typeof PROJECT_MODULES)[number];

/** Modules every project must enable (the instance's templates ship with Epics off). */
export const REQUIRED_MODULES: readonly ProjectModule[] = ['epics', 'wiki'];

/** Rules `module-known` and `module-required` for a list of enabled modules. */
export function checkModules(modules: unknown, at: string, issue: IssueSink): void {
  if (!Array.isArray(modules)) {
    issue(at, 'type', `must be a list of modules (${PROJECT_MODULES.join(', ')})`);
    return;
  }
  modules.forEach((module: unknown, index) => {
    if (!PROJECT_MODULES.includes(module as ProjectModule)) {
      issue(`${at}[${index}]`, 'module-known', `unknown module; use one of ${PROJECT_MODULES.join(', ')}`);
    }
  });
  for (const required of REQUIRED_MODULES) {
    if (!modules.includes(required)) issue(at, 'module-required', `module \`${required}\` must be enabled`);
  }
}

// ---- Tags ---------------------------------------------------------------------------------------

/** Tag prefixes a manifest may use. `src:<key>` exists too but only taigent writes it. */
export const TAG_PREFIXES = ['type', 'area'] as const;

/** The reserved identity prefix (`src:<key>`), managed by taigent. */
export const SRC_TAG_PREFIX = 'src';

/** Values allowed after `type:`. */
export const TYPE_TAG_VALUES = ['feature', 'bug', 'chore'] as const;

/** Lowercase kebab-case, as Taiga lowercases tags. */
const TAG_VALUE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Standard colors: every `area:*` tag shares one color; `src:*` tags have none. */
export const STANDARD_TAG_COLORS: Readonly<Record<string, string>> = {
  'type:feature': '#2E7D32',
  'type:bug': '#C62828',
  'type:chore': '#757575',
};
export const AREA_TAG_COLOR = '#1565C0';

/** The standard color of a valid tag, or undefined when it has none. */
export function standardTagColor(tag: string): string | undefined {
  return tag.startsWith('area:') ? AREA_TAG_COLOR : STANDARD_TAG_COLORS[tag];
}

/** Rules `tag-prefix`, `tag-format`, `tag-reserved` for one tag written in a manifest. */
export function checkTag(tag: unknown, at: string, issue: IssueSink): tag is string {
  if (typeof tag !== 'string' || tag === '') {
    issue(at, 'type', 'tag must be a non-empty string');
    return false;
  }
  const colon = tag.indexOf(':');
  const prefix = colon === -1 ? '' : tag.slice(0, colon);
  const value = tag.slice(colon + 1);
  if (prefix === SRC_TAG_PREFIX) {
    issue(at, 'tag-reserved', `\`${SRC_TAG_PREFIX}:\` tags are added by taigent from the item key; remove "${tag}"`);
    return false;
  }
  if (!TAG_PREFIXES.includes(prefix as (typeof TAG_PREFIXES)[number])) {
    issue(at, 'tag-prefix', `tag "${tag}" must start with one of ${TAG_PREFIXES.map((p) => `${p}:`).join(', ')}`);
    return false;
  }
  if (prefix === 'type' && !TYPE_TAG_VALUES.includes(value as (typeof TYPE_TAG_VALUES)[number])) {
    issue(at, 'tag-format', `tag "${tag}": type must be one of ${TYPE_TAG_VALUES.join(', ')}`);
    return false;
  }
  if (!TAG_VALUE_PATTERN.test(value)) {
    issue(at, 'tag-format', `tag "${tag}": value must be lowercase kebab-case, e.g. area:user-auth`);
    return false;
  }
  return true;
}

/** Rule `tag-color`: a declared tag uses its standard color. */
export function checkTagColor(tag: string, color: unknown, at: string, issue: IssueSink): void {
  const expected = standardTagColor(tag);
  if (expected === undefined) return;
  if (typeof color !== 'string' || color.toUpperCase() !== expected) {
    issue(at, 'tag-color', `tag "${tag}" must use the standard color ${expected}`);
  }
}

// ---- Item keys ----------------------------------------------------------------------------------

/** Stable item keys: uppercase letters/digits in dash-separated groups, e.g. `AUTH-LOGIN`. */
export const KEY_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * Rules `key-format` and `key-unique`. `seen` maps each key already declared in the project to the path
 * of its first use; a valid new key is added. Returns whether the key has a valid format.
 */
export function checkKey(key: unknown, at: string, issue: IssueSink, seen: Map<string, string>): key is string {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    issue(at, 'key-format', `key is required and must match ${KEY_PATTERN} (e.g. AUTH-LOGIN)`);
    return false;
  }
  const first = seen.get(key);
  if (first !== undefined) issue(at, 'key-unique', `duplicate key ${key} (first used at ${first})`);
  else seen.set(key, at);
  return true;
}

/** Rule `key-reference`: `ref` names an item declared in the backlog. */
export function checkKeyReference(ref: string, at: string, issue: IssueSink, keys: ReadonlySet<string>): void {
  if (!keys.has(ref)) issue(at, 'key-reference', `no epic, story or task with key ${ref} in backlog.yaml`);
}

/** How many words of the subject a suggested key keeps. */
const KEY_SUGGESTION_WORDS = 2;

/**
 * A key for a new item, after the naming advice of conventions §5: the first words of its subject (transliterated
 * like a project slug) under its parent's key (`<EPIC>-<việc>`, `<STORY>-<bước>`), with `-2`, `-3`… while `taken`
 * has it. Empty when there is neither a parent nor a letter or digit in the subject. Pure: Taigent Desktop's forms
 * use it.
 */
export function suggestKey(subject: string, parent: string | undefined, taken: ReadonlySet<string>): string {
  const words = projectSlug(subject).split(/[-_]+/).filter(Boolean).slice(0, KEY_SUGGESTION_WORDS);
  const base = [parent, ...words].filter(Boolean).join('-').toUpperCase();
  if (base === '' || !taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---- Wiki and attachments -----------------------------------------------------------------------

/** Wiki slugs: lowercase kebab-case, e.g. `home`, `spec-auth-login`, `adr-0001-use-rest`. */
export const WIKI_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The project's entry page (conventions §8), created by bootstrap from `wiki_home` in project.yaml. */
export const WIKI_HOME_SLUG = 'home';

/** Rule `wiki-slug`. */
export function checkWikiSlug(slug: unknown, at: string, issue: IssueSink): slug is string {
  const valid = typeof slug === 'string' && WIKI_SLUG_PATTERN.test(slug);
  if (!valid) issue(at, 'wiki-slug', 'wiki slug must be lowercase kebab-case, e.g. spec-auth-login');
  return valid;
}

/** Attachment file names: lowercase kebab-case base name plus extension, e.g. `auth-login-flow.pdf`. */
export const ATTACHMENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)+$/;

/** Rule `attachment-name` for the file name an attachment gets on Taiga. */
export function checkAttachmentName(name: string, at: string, issue: IssueSink): void {
  if (!ATTACHMENT_NAME_PATTERN.test(name)) {
    issue(at, 'attachment-name', `attachment file name "${name}" must be lowercase kebab-case with an extension, e.g. auth-login-flow.pdf`);
  }
}

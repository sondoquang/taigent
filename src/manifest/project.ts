// Project manifest `taiga/<slug>/project.yaml`: the desired Taiga project that `taigent bootstrap` creates
// or completes. Schema checks live here; naming/template/module/tag rules come from conventions.ts.

import { parseDay } from '../days.ts';
import { isRecord } from '../guards.ts';
import { ITEM_TYPES, type ItemType } from '../items.ts';
import {
  checkModules,
  checkProjectName,
  checkProjectSlug,
  checkReleaseVersion,
  checkTag,
  checkTagColor,
  checkTemplate,
  standardTagColor,
  type ProjectModule,
  type ProjectTemplate,
} from './conventions.ts';
import { ManifestError, type ManifestIssue } from './errors.ts';
import { readManifestYaml } from './yaml.ts';

export const PROJECT_FILE = 'project.yaml';

/** Taiga custom attribute types taigent can create (`dropdown` needs options and is not supported). */
export const CUSTOM_ATTRIBUTE_TYPES = ['text', 'multiline', 'richtext', 'date', 'url', 'checkbox', 'number'] as const;
export type CustomAttributeType = (typeof CUSTOM_ATTRIBUTE_TYPES)[number];

export interface TagSpec {
  name: string;
  /** `#RRGGBB`; defaults to the tag's standard color. */
  color: string;
}

export interface CustomAttributeSpec {
  name: string;
  description: string;
  type: CustomAttributeType;
}

/** Exactly one of `username`/`email` identifies the member; `role` is the Taiga role name (or slug). */
export interface MemberSpec {
  username?: string;
  email?: string;
  role: string;
}

/** A release (ADR 0005): the stories tagged `release:<version>` on Taiga, due on `target` (YYYY-MM-DD). */
export interface ReleaseSpec {
  version: string;
  target: string;
}

export interface ProjectManifest {
  name: string;
  slug: string;
  description: string;
  template: ProjectTemplate;
  isPrivate: boolean;
  /** Modules to enable; unlisted modules are left as they are. */
  modules: ProjectModule[];
  tags: TagSpec[];
  customAttributes: Record<ItemType, CustomAttributeSpec[]>;
  members: MemberSpec[];
  /** Markdown of the wiki page `home`, when declared. */
  wikiHome: string | undefined;
  /** Releases the dashboards draw a burndown for, in the order declared; none when not declared. */
  releases: ReleaseSpec[];
}

const PROJECT_FIELDS: Record<string, true> = {
  name: true, slug: true, description: true, template: true, is_private: true, modules: true, tags: true,
  custom_attributes: true, members: true, wiki_home: true, releases: true,
};
const TAG_FIELDS: Record<string, true> = { name: true, color: true };
const ATTRIBUTE_FIELDS: Record<string, true> = { name: true, description: true, type: true };
const MEMBER_FIELDS: Record<string, true> = { username: true, email: true, role: true };
const RELEASE_FIELDS: Record<string, true> = { version: true, target: true };

/** Reads and validates the project manifest at `path`; `dirSlug` is the name of its directory. */
export async function loadProject(path: string, dirSlug: string): Promise<ProjectManifest> {
  const doc = await readManifestYaml(path);

  const issues: ManifestIssue[] = [];
  const issue = (at: string, rule: string, message: string) => issues.push({ file: path, path: at, rule, message });
  const unknownFields = (raw: Record<string, unknown>, allowed: Record<string, true>, at: string, what: string) => {
    for (const field of Object.keys(raw)) {
      if (!Object.hasOwn(allowed, field)) issue(at ? `${at}.${field}` : field, 'known-field', `unknown ${what} field \`${field}\``);
    }
  };

  if (!isRecord(doc)) {
    issue('', 'type', 'project manifest must be a mapping');
    throw new ManifestError(issues);
  }
  unknownFields(doc, PROJECT_FIELDS, '', 'project');
  const { name, slug, description, template, is_private: isPrivate = true, modules, tags = [], custom_attributes: attributes = {}, members = [], wiki_home: wikiHome, releases = [] } = doc;

  checkProjectName(name, 'name', issue);
  checkProjectSlug(slug, name, 'slug', issue);
  if (typeof slug === 'string' && slug !== dirSlug) {
    issue('slug', 'project-dir', `slug "${slug}" must equal the manifest directory name "${dirSlug}"`);
  }
  if (typeof description !== 'string' || description.trim() === '') issue('description', 'required', 'description is required (Taiga requires one)');
  checkTemplate(template, 'template', issue);
  if (typeof isPrivate !== 'boolean') issue('is_private', 'type', 'must be true or false');
  checkModules(modules, 'modules', issue);
  if (wikiHome !== undefined && (typeof wikiHome !== 'string' || wikiHome.trim() === '')) issue('wiki_home', 'type', 'must be non-empty Markdown text');

  const tagSpecs: TagSpec[] = [];
  if (!Array.isArray(tags)) issue('tags', 'type', 'must be a list of { name, color }');
  else {
    const seen = new Set<string>();
    tags.forEach((raw: unknown, index) => {
      const at = `tags[${index}]`;
      if (!isRecord(raw)) return void issue(at, 'type', 'tag must be a mapping { name, color }');
      unknownFields(raw, TAG_FIELDS, at, 'tag');
      if (!checkTag(raw.name, `${at}.name`, issue)) return;
      if (seen.has(raw.name)) return void issue(`${at}.name`, 'tag-unique', `duplicate tag ${raw.name}`);
      seen.add(raw.name);
      if (raw.color !== undefined) checkTagColor(raw.name, raw.color, `${at}.color`, issue);
      tagSpecs.push({ name: raw.name, color: ((raw.color as string | undefined) ?? standardTagColor(raw.name)!).toUpperCase() });
    });
  }

  const customAttributes: ProjectManifest['customAttributes'] = { epic: [], story: [], task: [], issue: [] };
  if (!isRecord(attributes)) issue('custom_attributes', 'type', `must be a mapping of ${ITEM_TYPES.join(', ')} to lists`);
  else {
    for (const [itemType, list] of Object.entries(attributes)) {
      const at = `custom_attributes.${itemType}`;
      if (!ITEM_TYPES.includes(itemType as ItemType)) {
        issue(at, 'known-field', `unknown item type; use one of ${ITEM_TYPES.join(', ')}`);
        continue;
      }
      if (!Array.isArray(list)) {
        issue(at, 'type', 'must be a list of { name, description?, type? }');
        continue;
      }
      const seen = new Set<string>();
      list.forEach((raw: unknown, index) => {
        const itemAt = `${at}[${index}]`;
        if (!isRecord(raw)) return void issue(itemAt, 'type', 'custom attribute must be a mapping');
        unknownFields(raw, ATTRIBUTE_FIELDS, itemAt, 'custom attribute');
        const { name: attrName, description: attrDescription = '', type = 'text' } = raw;
        if (typeof attrName !== 'string' || attrName.trim() === '') issue(`${itemAt}.name`, 'required', 'name is required');
        else if (seen.has(attrName)) issue(`${itemAt}.name`, 'attribute-unique', `duplicate ${itemType} custom attribute ${attrName}`);
        else seen.add(attrName);
        if (typeof attrDescription !== 'string') issue(`${itemAt}.description`, 'type', 'must be a string');
        if (!CUSTOM_ATTRIBUTE_TYPES.includes(type as CustomAttributeType)) {
          issue(`${itemAt}.type`, 'attribute-type', `type must be one of ${CUSTOM_ATTRIBUTE_TYPES.join(', ')}`);
        }
        customAttributes[itemType as ItemType].push({ name: attrName, description: attrDescription, type } as CustomAttributeSpec);
      });
    }
  }

  const memberSpecs: MemberSpec[] = [];
  if (!Array.isArray(members)) issue('members', 'type', 'must be a list of { username | email, role }');
  else {
    const seen = new Set<string>();
    members.forEach((raw: unknown, index) => {
      const at = `members[${index}]`;
      if (!isRecord(raw)) return void issue(at, 'type', 'member must be a mapping { username | email, role }');
      unknownFields(raw, MEMBER_FIELDS, at, 'member');
      const { username, email, role } = raw;
      const ids = [username, email].filter((value) => value !== undefined);
      if (ids.length !== 1 || !ids.every((value) => typeof value === 'string' && value !== '')) {
        issue(at, 'member-identity', 'member needs exactly one of `username` or `email`');
      } else if (email !== undefined && !/^[^@\s]+@[^@\s]+$/.test(email as string)) {
        issue(`${at}.email`, 'member-email', `"${String(email)}" is not an e-mail address`);
      } else {
        const id = (ids[0] as string).toLowerCase();
        if (seen.has(id)) issue(at, 'member-unique', `duplicate member ${String(ids[0])}`);
        seen.add(id);
      }
      if (typeof role !== 'string' || role.trim() === '') issue(`${at}.role`, 'required', 'role (Taiga role name, e.g. Back) is required');
      memberSpecs.push({ ...(username !== undefined && { username: username as string }), ...(email !== undefined && { email: email as string }), role: role as string });
    });
  }

  const releaseSpecs: ReleaseSpec[] = [];
  if (!Array.isArray(releases)) issue('releases', 'type', 'must be a list of { version, target }');
  else {
    const seen = new Set<string>();
    releases.forEach((raw: unknown, index) => {
      const at = `releases[${index}]`;
      if (!isRecord(raw)) return void issue(at, 'type', 'release must be a mapping { version, target }');
      unknownFields(raw, RELEASE_FIELDS, at, 'release');
      const versionOk = checkReleaseVersion(raw.version, `${at}.version`, issue, seen);
      const target = raw.target;
      const targetOk = typeof target === 'string' && parseDay(target) !== undefined;
      if (!targetOk) issue(`${at}.target`, 'release-target', 'target is required and must be a calendar day YYYY-MM-DD (e.g. 2026-12-01)');
      if (versionOk && targetOk) releaseSpecs.push({ version: raw.version as string, target });
    });
  }

  if (issues.length > 0) throw new ManifestError(issues);
  return {
    name: name as string,
    slug: slug as string,
    description: description as string,
    template: template as ProjectTemplate,
    isPrivate: isPrivate as boolean,
    modules: modules as ProjectModule[],
    tags: tagSpecs,
    customAttributes,
    members: memberSpecs,
    wikiHome: wikiHome as string | undefined,
    releases: releaseSpecs,
  };
}

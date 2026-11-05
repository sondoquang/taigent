// Release burndown of `taigent metrics` (Product Owner, ADR 0005): a release is the user stories tagged
// `release:<version>` on Taiga, its target day is declared in project.yaml. The burndown never guesses when the two
// disagree: it warns (an undeclared tag, a declared release without stories, a story with two release tags or more).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, daysBetween } from '../days.ts';
import { RELEASE_TAG_PREFIX } from '../manifest/conventions.ts';
import { loadProject, PROJECT_FILE, type ReleaseSpec } from '../manifest/project.ts';
import type { MetricsContext } from './context.ts';
import type { WorkItem } from './work.ts';

export interface BurndownDay {
  /** YYYY-MM-DD, local time zone. */
  day: string;
  /** Points of the release's stories still open at the end of the day; null after today. */
  remaining: number | null;
  /** The ideal line, from every point on the start day to none on the target day; null for an undeclared release. */
  ideal: number | null;
}

export interface ReleaseMetrics {
  version: string;
  /** The Taiga tag, `release:<version>`. */
  tag: string;
  /** Whether project.yaml declares it; an undeclared one has no target and no ideal line. */
  declared: boolean;
  target: string | null;
  /** The local day the release's earliest story was created; null without stories. */
  start: string | null;
  stories: { total: number; closed: number };
  /** Unestimated stories count as no points. */
  points: { total: number; closed: number; remaining: number };
  /** Every day from `start` to today, or to the target when it is later; none without stories. */
  days: BurndownDay[];
}

/** A story carrying two release tags or more: left out of every burndown. */
export interface MultiTaggedStory {
  id: number;
  ref: number;
  subject: string;
  /** Its release versions, sorted. */
  releases: string[];
}

export interface ReleaseBurndown {
  /** The declared releases in project.yaml's order, then the undeclared tags by version. */
  releases: ReleaseMetrics[];
  multiTagged: MultiTaggedStory[];
}

/** The releases declared in `<dir>/project.yaml`; none without that file. An invalid file throws ManifestError. */
export async function readReleases(dir: string, slug: string): Promise<ReleaseSpec[]> {
  const path = join(dir, PROJECT_FILE);
  return existsSync(path) ? (await loadProject(path, slug)).releases : [];
}

const PREFIX = `${RELEASE_TAG_PREFIX}:`;

export function releaseBurndown(context: MetricsContext): ReleaseBurndown {
  const { snapshot, local, today, work, notes } = context;
  const items = new Map(work.filter((item) => item.type === 'story').map((item) => [item.id, item]));
  const byVersion = new Map<string, WorkItem[]>(local.releases.map((release) => [release.version, []]));
  const multiTagged: MultiTaggedStory[] = [];
  for (const story of snapshot.stories) {
    const versions = [...new Set(story.tags.filter((tag) => tag.startsWith(PREFIX)).map((tag) => tag.slice(PREFIX.length)))].sort();
    if (versions.length === 0) continue;
    if (versions.length > 1) {
      multiTagged.push({ id: story.id, ref: story.ref, subject: story.subject, releases: versions });
      continue;
    }
    const version = versions[0]!;
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version)!.push(items.get(story.id)!);
  }

  const targets = new Map(local.releases.map((release) => [release.version, release.target]));
  const undeclared = [...byVersion.keys()].filter((version) => !targets.has(version)).sort();
  const releases = [...targets.keys(), ...undeclared].map((version) => burndown(version, targets.get(version) ?? null, byVersion.get(version)!, today));

  for (const release of releases) {
    if (!release.declared) {
      notes.warnings.push({ code: 'release-undeclared', message: `user stories carry the tag ${release.tag} but project.yaml declares no release ${release.version}: drawn without an ideal line` });
    }
  }
  for (const release of releases) {
    if (release.declared && release.stories.total === 0) {
      notes.warnings.push({ code: 'release-empty', message: `release ${release.version} is declared in project.yaml but no user story carries only the tag ${release.tag}` });
    }
  }
  for (const story of multiTagged) {
    notes.warnings.push({ code: 'release-multiple', message: `user story #${story.ref} ${story.subject} carries ${story.releases.map((version) => PREFIX + version).join(', ')}: left out of every release burndown` });
  }
  return { releases, multiTagged };
}

function burndown(version: string, target: string | null, stories: WorkItem[], today: string): ReleaseMetrics {
  const points = (list: WorkItem[]) => list.reduce((sum, story) => sum + (story.points ?? 0), 0);
  const closed = stories.filter((story) => story.closed);
  const total = points(stories);
  const created = stories.map((story) => story.createdDay).filter((created): created is string => created !== null).sort();
  const start = created[0] ?? (stories.length > 0 ? today : null);
  const days: BurndownDay[] = [];
  if (start !== null) {
    const last = target !== null && target > today ? target : today;
    const span = target === null ? 0 : daysBetween(start, target);
    for (let day = start; day <= last; day = addDays(day, 1)) {
      // A story closed without a recorded day counts as closed from the start.
      const remaining = day > today ? null : points(stories.filter((story) => !story.closed || (story.closedDay !== null && story.closedDay > day)));
      // Linear from every point on the start day to none on the target, in hundredths of a point.
      let ideal: number | null = null;
      if (target !== null) ideal = span <= 0 || day >= target ? 0 : Math.round(total * (1 - daysBetween(start, day) / span) * 100) / 100;
      days.push({ day, remaining, ideal });
    }
  }
  return {
    version,
    tag: PREFIX + version,
    declared: target !== null,
    target,
    start,
    stories: { total: stories.length, closed: closed.length },
    points: { total, closed: points(closed), remaining: total - points(closed) },
    days,
  };
}

/** The text form: one line per release, then the stories left out. */
export function formatReleaseText(burndown: ReleaseBurndown): string[] {
  const lines = ['Release burndown:'];
  if (burndown.releases.length === 0) lines.push('  no release declared or tagged');
  for (const release of burndown.releases) {
    const name = `  Release ${release.version}${release.declared ? '' : ' (undeclared)'}`;
    const target = release.target === null ? 'no target' : `target ${release.target}`;
    if (release.stories.total === 0) {
      lines.push(`${name}: no user story, ${target}`);
      continue;
    }
    const { points, stories } = release;
    lines.push(`${name}: ${points.remaining} of ${points.total} points left (${stories.total - stories.closed} of ${stories.total} stories open), ${target}`);
  }
  for (const story of burndown.multiTagged) lines.push(`  Left out, two release tags or more: #${story.ref} ${story.subject} (${story.releases.join(', ')})`);
  return lines;
}

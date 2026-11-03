// Story template: the description apply writes to Taiga for a story. Pure and free of Node imports, so `buildPlan`,
// `taigent preview` and Taigent Desktop's story form (bundled into its renderer) all render the same text.

import type { LegacyFormat, Scenario, StorySpec, UserStoryFormat } from './manifest/backlog.ts';

/** What the template reads from a story (a `StorySpec` is one). */
export type StoryText = { description: string; spec: string } & (UserStoryFormat | LegacyFormat);

/**
 * Story description. The user story format renders the use case, the free text, one checkbox per scenario with its
 * Given/When/Then, then the spec link. The legacy format keeps its template byte for byte: free text, acceptance
 * criteria as a checklist, then the spec link.
 */
export function storyDescription(story: StoryText): string {
  const parts: string[] = [];
  let checklist: string[];
  if (story.format === 'user-story') {
    const { asA, iWantTo, soThat } = story.useCase;
    parts.push([`- **As a** ${asA}`, `- **I want to** ${iWantTo}`, `- **so that** ${soThat}`].join('\n'));
    checklist = story.scenarios.flatMap(({ scenario, given, when, then }) => [
      `- [ ] **Scenario:** ${scenario}`,
      ...given.map((condition, i) => `  - **${i === 0 ? 'Given' : 'and Given'}:** ${condition}`),
      `  - **When:** ${when}`,
      `  - **Then:** ${then}`,
    ]);
  } else {
    checklist = story.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`);
  }
  if (story.description.trim() !== '') parts.push(story.description.trimEnd());
  if (checklist.length > 0) parts.push(['## Acceptance criteria', '', ...checklist].join('\n'));
  if (story.spec !== '') parts.push(`Spec: ${story.spec}`);
  return parts.join('\n\n');
}

const USE_CASE = /^- \*\*As a\*\* (.*)\n- \*\*I want to\*\* (.*)\n- \*\*so that\*\* (.*)(?:\n\n|$)/;
const CRITERIA_HEADING = '## Acceptance criteria\n\n';

/**
 * The story whose template `storyDescription` renders exactly `text`, in `format`: the inverse of the template, for
 * `taigent pull`. Undefined when `text` is not such a rendering (edited outside the template). Pure.
 */
export function parseStoryDescription(text: string, format: StorySpec['format']): StoryText | undefined {
  let rest = text;
  const head = format === 'user-story' ? USE_CASE.exec(rest) : null;
  if (format === 'user-story') {
    if (!head) return undefined;
    rest = rest.slice(head[0].length);
  }
  let spec = '';
  const specLine = /(?:^|\n\n)Spec: (.*)$/.exec(rest);
  if (specLine) {
    spec = specLine[1]!;
    rest = rest.slice(0, specLine.index);
  }
  let lines: string[] = [];
  const heading = rest.startsWith(CRITERIA_HEADING) ? 0 : rest.lastIndexOf(`\n\n${CRITERIA_HEADING}`);
  if (heading !== -1) {
    lines = rest.slice(rest.indexOf(CRITERIA_HEADING, heading) + CRITERIA_HEADING.length).split('\n');
    rest = rest.slice(0, heading);
  }
  let story: StoryText;
  if (format === 'user-story') {
    const scenarios: Scenario[] = [];
    for (const line of lines) {
      const current = scenarios.at(-1);
      const [, field, value] = /^(?:- \[ \] \*\*(Scenario):\*\*|  - \*\*(?:and )?(Given|When|Then):\*\*) (.*)$/.exec(line)?.filter((part) => part !== undefined) ?? [];
      if (field === 'Scenario') scenarios.push({ scenario: value!, given: [], when: '', then: '' });
      else if (!current || value === undefined) return undefined;
      else if (field === 'Given') current.given.push(value);
      else current[field === 'When' ? 'when' : 'then'] = value;
    }
    story = { format, useCase: { asA: head![1]!, iWantTo: head![2]!, soThat: head![3]! }, scenarios, description: rest, spec };
  } else {
    const acceptanceCriteria: string[] = [];
    for (const line of lines) {
      const criterion = /^- \[ \] (.*)$/.exec(line)?.[1];
      if (criterion === undefined) return undefined;
      acceptanceCriteria.push(criterion);
    }
    story = { format, acceptanceCriteria, description: rest, spec };
  }
  // Anything the patterns let through but the template would not write (a missing When, a doubled Given…) fails here.
  return storyDescription(story) === text ? story : undefined;
}

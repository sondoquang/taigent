// Story template: the description apply writes to Taiga for a story. Pure and free of Node imports, so `buildPlan`,
// `taigent preview` and Taigent Desktop's story form (bundled into its renderer) all render the same text.

import type { LegacyFormat, UserStoryFormat } from './manifest/backlog.ts';

/** What the template reads from a story (a `StorySpec` is one). */
export type StoryText = { description: string; spec: string } & (UserStoryFormat | LegacyFormat);

/**
 * Story description. The user story format renders the use case, the free text, one checkbox per scenario with its
 * Given/When/Then, then the spec link. The legacy format keeps its template byte for byte: free text, acceptance
 * criteria as a checklist, then the spec link; a legacy story with neither criteria nor spec (a free-text story
 * adopted from Taiga) renders exactly its description, line endings and trailing whitespace included.
 */
export function storyDescription(story: StoryText): string {
  if (story.format === 'legacy' && story.acceptanceCriteria.length === 0 && story.spec === '') return story.description;
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

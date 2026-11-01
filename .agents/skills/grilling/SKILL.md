---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask *now* without guessing at answers you haven't heard yet.

Ask the whole frontier in one round, giving your recommended answer for every question. Then wait for the user's answers before the next round.

## Interactive Questioning — Oh My Pi

When running inside Oh My Pi (OMP), ALWAYS use the native `ask` tool for all decision questions.

### Mandatory Rules

1. MUST use `ask` instead of rendering Markdown questionnaires.
2. NEVER require the user to type answers like `1a, 2b, 3c`.
3. Group all independent frontier questions into a single `ask` tool call.
4. Provide clear, concise selectable options with descriptions.
5. Set the `recommended` option index for each question whenever applicable.
6. Include a short explanation of the recommendation in its option description.
7. Use `multi: true` only when multiple selections are valid.
8. Allow custom free-text answers through the native OMP interface.
9. Do not manually add an "Other" option when OMP already provides free-text input.
10. Never assume an answer or select an option without the user's input.
11. Wait for the `ask` result before advancing the design tree.
12. Do not replace interactive questions with plain text unless the `ask` tool is unavailable.

### Question Structure

For each frontier question, provide:

- `id`: A unique identifier for the question.
- `header`: A short question title.
- `question`: The decision the user needs to make.
- `options`: Selectable answers, each with a label and useful description.
- `recommended`: Zero-based index of the recommended option.
- `multi`: Whether multiple answers are allowed.

Prefer 2–5 meaningful options per question.

Do not ask questions merely to fill a batch.

### Round Execution

1. Determine the current frontier of the design tree.
2. Identify all independent decisions that can be answered now.
3. Prepare structured questions with recommendations.
4. Call the native OMP `ask` tool once for the entire frontier.
5. Wait for the user to complete the interactive questions.
6. Record the user's selections, including custom answers.
7. Update the design tree based on those answers.
8. Recompute the frontier.
9. Repeat until the frontier is empty.

A question whose answer depends on another question still open in the current round belongs to a *later* round, not this one.

### Fallback

If the native `ask` tool is unavailable:

- Ask one question at a time using plain text.
- Provide numbered selectable options.
- Clearly indicate the recommended answer.
- Never present a large batch requiring encoded answers.

## Fact Finding

Finding *facts* is your job, never the user's.

When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself.

Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now.

The *decisions* are the user's: put each to them and wait.

## Completion and Implementation Handoff

The grilling session ends when the frontier is empty: every branch of the design tree visited, nothing left silently assumed.

### Confirmation Gate

When the frontier is empty:

1. Summarize every settled decision.
2. Present unresolved risks and assumptions.
3. Use the native OMP `ask` tool to confirm shared understanding.

The confirmation question MUST distinguish agreement
from authorization to implement.

Provide these options:

- "Confirm and stop (Recommended)"
  The design is approved. Do not implement anything.

- "Needs changes"
  Continue grilling the unresolved decisions.

Never label an option "Confirm and start implementing".

### After Confirmation

When the user confirms:

1. Mark the grilling session as complete.
2. Preserve the agreed decisions in context.
3. Do NOT start coding.
4. Do NOT create OMP TODOs or launch an implementation plan.
5. Recommend the next Matt Pocock skill.

Routing:

- Small, single-session work: `/implement`
- Larger work requiring a spec: `/to-spec`
- Work with approved spec and tickets: `/implement-spec`

Explicitly tell the user which skill to invoke next.

Do not simulate another skill's workflow.

### Implementation Authorization

Only begin implementation after the user explicitly
invokes the appropriate implementation skill.

Agreement with the design is NOT authorization
to implement it.

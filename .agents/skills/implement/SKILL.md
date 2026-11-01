---
name: implement
description: "Implement a piece of work based on a spec, tickets, or confirmed grilling decisions."
disable-model-invocation: true
---

Implement the work described by the user using one of these sources:

1. An approved specification.
2. A set of implementation tickets.
3. Confirmed design decisions from a completed grilling session.

## Context

If invoked after `/grill-me` or `/grill-with-docs`:

- Reuse all confirmed design decisions.
- Preserve agreed scope, constraints, and architecture.
- Do not restart the grilling interview.
- Do not silently change previously approved decisions.
- Ask for clarification only if a critical detail is missing.

## Implementation

Implement the agreed work.

- Use `/tdd` where possible, at pre-agreed seams.
- Run typechecking regularly.
- Run relevant single test files regularly.
- Run the full test suite once at the end.

## Review

Once implementation is complete:

- Use `/code-review` to review the work.
- Address critical issues found during review.
- Re-run affected tests after fixes.

## Completion

- Commit your work to the current branch.
- Summarize implemented changes.
- Report test results and remaining issues.

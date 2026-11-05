# Taigent

Taigent turns a project's plans into Taiga epics, stories and tasks, and reports on the work tracked there.

## Language

### Planning the backlog

**User story**:
A Taiga story in the backlog, assigned or not: who wants what and why, and the acceptance criteria that prove it is done.
_Avoid_: Ticket (reserved for a user story assigned to you), card, item

**User story format**:
The shape every new user story takes: a Mike Cohn use case (As a / I want to / so that) and one or more Gherkin scenarios (Given / When / Then) as its acceptance criteria.
_Avoid_: New format, Cohn format

**Legacy format**:
The earlier shape of a user story, free text with a list of acceptance criteria, kept only for user stories already on Taiga.
_Avoid_: Old format

**Backlog item**:
An epic, story, task or issue planned in a project's backlog manifest, whether or not it is on Taiga yet.
_Avoid_: Ticket (reserved for a user story assigned to you), card

**Issue**:
A bug or other problem planned as a backlog item and filed in Taiga's issues module; it stands apart from the epic → story → task tree.
_Avoid_: Ticket, bug (when the issue's type is not Bug)

**Review**:
The Business Analyst's or Product Owner's check of the planned backlog items before they are applied to Taiga, kept in the project's `review.yaml` as verdicts and comments per item.
_Avoid_: Approval (a review is not consent to apply)

**Verdict**:
A reviewer's decision on one backlog item: approved, or changes requested. Only the reviewer sets it.

**Stale verdict**:
A verdict given on an earlier version of the item: what apply would write for it has changed since, so it must be reviewed again.

**Review comment**:
A reviewer's remark on one backlog item; open until the agent addresses it in the manifest and marks it resolved with a reply.

### Reporting on your work

**Ticket**:
A user story assigned to you. Tasks and issues are not tickets.
_Avoid_: Card, item (for a story); ticket for a task or an issue

**Period's tickets**:
The tickets of a reporting period: those closed in it, those due in it, and every ticket still open.

**Due status**:
Where a ticket stands against its due date, compared by calendar day in local time: one of On time, Late, Overdue, On track, No due date. A closed ticket with a due date but no closing day has no due status.

**On time**:
A closed ticket whose closing day is on or before its due date.

**Late**:
A closed ticket whose closing day is after its due date.

**Overdue**:
An open ticket whose due date has passed.
_Avoid_: Late (reserved for closed tickets)

**On track**:
An open ticket whose due date is today or later.

**No due date**:
A ticket without a due date; it has no due status beyond this.

**Effort**:
The hours a ticket took: its Spent Time, or its points when Spent Time is empty, one point counting as one hour.
_Avoid_: Duration (for the reported figure)

**Bulk close**:
Three or more tickets closed one after another, each within 60 seconds of the previous one.

**End-of-day reminder**:
The message, near the end of a working day, listing your open tickets whose due date is today or earlier. "Close them" in answer to it means those tickets.
_Avoid_: Stale tickets (it is about due dates, not about how long a status has stood)

### Dashboards

**Role**:
What you do on the project, chosen by you: Developer, Product Owner or Business Analyst. It decides which dashboard you see first; it is not your role on the Taiga project.
_Avoid_: Taiga role, membership role (those are the project's own role names)

**Bug**:
An issue whose type is Bug. A story tagged as a bug is not a bug here.

**Resolved bug**:
A bug in Ready for test or Closed. A Rejected bug is not resolved; it is counted on its own.
_Avoid_: Closed bug (Rejected is closed but not resolved)

**Complete acceptance criteria**:
A user story in the user story format whose acceptance criteria hold at least one scenario with Given, When and Then. A story in the legacy format never has complete acceptance criteria.

**Requirements coverage**:
The share of epics that have at least one user story with complete acceptance criteria.

**Awaiting review**:
A backlog item with no verdict or a stale verdict, whoever the reviewer is.
_Avoid_: Awaiting PO confirmation (a review does not record the reviewer's role and is not approval)

**Pending clarification**:
A backlog item with an open review comment.

**Release**:
A version of the product, named by a `release:` tag that people put on user stories in Taiga, with a target date the project declares. A user story belongs to at most one release.
_Avoid_: Sprint, milestone, epic

**Workload**:
The open user stories and open tasks assigned to one person, counted apart, with the points of those stories.
_Avoid_: Effort (the hours a closed ticket took)

**Lead time**:
From the day a user story or task is created to the day it is closed.

**Cycle time**:
From the first time a user story or task enters In progress to the day it is closed. Ready for test is not closed.

**Scope change**:
User stories added to or taken out of a sprint after the sprint has started, with their points.

**Requirement change**:
An edit to a user story's description on Taiga after the story has reached Ready.

**Reopened bug**:
A resolved bug that moves back to an open status. The reopen rate is reopened bugs over bugs resolved in the same period.

**Resolution time**:
From the day a bug is created to the day it is resolved. A Rejected bug has none.

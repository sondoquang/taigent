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

**Hand-made item**:
An epic, story, task or issue on Taiga that no backlog item is bound to, because someone created it there rather than through Taigent.
_Avoid_: Legacy item, untracked item

**Adopt**:
To bind a hand-made item to a new backlog item, so the work on Taiga stays and is managed from then on like the items Taigent created.
_Avoid_: Import (nothing is copied or created again), claim (means taking a ticket for yourself), link (reserved for an epic's stories)

**Snapshot**:
A read-only copy of a project's epics and open stories, tasks and issues as they stood on Taiga at one moment, read for context while planning.
_Avoid_: Mirror, cache, export

**Remote edit**:
A change made on Taiga to a backlog item since Taigent last wrote it; Taiga's version wins and the backlog item takes it before anything else is written.
_Avoid_: Drift, conflict

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

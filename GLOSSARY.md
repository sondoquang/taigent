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

**Baseline**:
The values of a backlog item as Taigent last wrote them to Taiga or took them from it; Taiga and the backlog item are each compared with it to tell who changed what.
_Avoid_: Cache, last state, snapshot (a snapshot is the whole project as read for planning)

**Remote edit**:
A change made on Taiga to a backlog item since its baseline, while the backlog item kept its baseline values; Taiga's version wins and the backlog item takes it before anything else is written, unless the user deliberately keeps the backlog item's.
_Avoid_: Drift, conflict

**Both edited**:
A backlog item changed both on Taiga and in the backlog since its baseline, differently; the user merges the two before anything is written.
_Avoid_: Conflict (reserved for Taiga refusing a write because the item changed meanwhile)

**Unknown origin**:
A backlog item on Taiga with no baseline whose Taiga version differs from the backlog's, so nobody can tell which side changed.
_Avoid_: Unknown item, untracked item

**Blocked item**:
A backlog item Taigent leaves untouched until the user settles it: a remote edit, both edited, or unknown origin.
_Avoid_: Conflict, locked item

**Review**:
The Business Analyst's or Product Owner's check of the planned backlog items before they are applied to Taiga, kept in the project's `review.yaml` as verdicts and comments per item.
_Avoid_: Approval (a review is not consent to apply)

**Verdict**:
A reviewer's decision on one backlog item: approved, or changes requested. Only the reviewer decides it; an agent records it only on the reviewer's explicit word, never on its own judgment.

**Stale verdict**:
A verdict given on an earlier version of the item: what apply would write for it has changed since, so it must be reviewed again.

**Review comment**:
A reviewer's remark on one backlog item; open until the agent addresses it in the manifest and marks it resolved with a reply.

### Reporting on your work

**Ticket**:
A user story assigned to you. Tasks and issues are not tickets.
_Avoid_: Card, item (for a story); ticket for a task or an issue

**Planned ticket**:
A ticket in Ready, In progress or Ready for test: work planned for you. A ticket in New is not planned yet.
_Avoid_: Open ticket (a ticket in New is open too)

**Finished ticket**:
A ticket in Ready for test or Done: the developer's part is done. A ticket moved back to In progress is no longer finished.
_Avoid_: Closed ticket (Ready for test is not closed on Taiga)

**Progress group**:
Where a ticket stands in its work, by its status: Ready, In progress, Ready for test or Done.

**Period's tickets**:
The planned tickets, plus the tickets that moved to Done in the reporting period.

**Due status**:
Where a ticket stands against its due date, compared by calendar day in local time: one of On time, Late, Overdue, Due today, On track, No due date. The due date is the day the ticket must be finished.

**Finishing day**:
The last day a ticket became finished. A ticket that went back to In progress and was finished again finishes on the later day.

**On time**:
A finished ticket whose finishing day is on or before its due date.

**Late**:
A finished ticket whose finishing day is after its due date.

**Overdue**:
A ticket not finished whose due date has passed.
_Avoid_: Late (reserved for finished tickets)

**Due today**:
A ticket not finished whose due date is today.

**On track**:
A ticket not finished whose due date is after today.

**No due date**:
A ticket without a due date; it has no due status beyond this.

**Effort**:
The hours a ticket took: its Spent Time, or its points when Spent Time is empty, one point counting as one hour.
_Avoid_: Duration (for the reported figure)

**Working day**:
Monday to Friday, eight hours of work ending at 17:00.

**Remaining work**:
The hours a ticket still needs: its points, one point counting as one hour, less its Spent Time, never below zero.
_Avoid_: Effort (the hours a ticket took)

**Plan**:
The remaining work of your planned tickets that are not finished, laid on working days from today (from the next working day after 17:00), in due-date order with In progress first on the same date, eight hours a day. Tickets without a due date or without points stay out of it.
_Avoid_: Schedule, sprint

**Latest start day**:
The day a ticket must start to be finished by its due date, counting back its remaining work from the due date, eight hours a day.

**Late start**:
A ticket still in Ready on or after its latest start day.
_Avoid_: Overdue (about the due date, not the start)

**At risk**:
A ticket not finished whose plan finishes it after its due date.
_Avoid_: Overdue (its due date has not passed)

**Re-plan**:
For each ticket at risk, a proposed new due date, the day the plan finishes it, with a comment naming the tickets that share its days. Nothing is written to Taiga until you approve it.

**Bulk close**:
Three or more tickets closed one after another, each within 60 seconds of the previous one.

**End-of-day reminder**:
The message, near the end of a working day, listing your planned tickets not finished whose due date is today or earlier, with their re-plan to approve. Its re-plan counts from the next working day, as after 17:00. "Close them" in answer to it moves those tickets to Ready for test; moving them to Done takes your explicit request and your confirmation that they were tested.
_Avoid_: Stale tickets (it is about due dates, not about how long a status has stood)

### Dashboards

**Dashboard**:
The metrics of one project reported for a role, on request. It is a report, not a screen.
_Avoid_: Screen, panel

**Role**:
What you do on the project, chosen by you: Developer, Product Owner or Business Analyst. It decides which metrics the dashboard reports first; it is not your role on the Taiga project.
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
_Avoid_: Effort (the hours a ticket took)

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

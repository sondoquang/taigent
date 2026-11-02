// Backlog item types: the one vocabulary of manifests (project.yaml custom_attributes keys), plans, reports and
// state.json. Only the Taiga client knows Taiga's names for them (`userstories`, `userstory-custom-attributes`, …).

export const ITEM_TYPES = ['epic', 'story', 'task', 'issue'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/**
 * The fields of an issue whose value is one of the project's own values on Taiga, written by name in backlog.yaml
 * (`type: Bug`) and sent by id. Only the Taiga client knows where each list lives (`/issue-types`, …).
 */
export const ISSUE_VALUE_FIELDS = ['type', 'severity', 'priority'] as const;
export type IssueValueField = (typeof ISSUE_VALUE_FIELDS)[number];

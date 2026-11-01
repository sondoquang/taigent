// Backlog item types: the one vocabulary of manifests (project.yaml custom_attributes keys), plans, reports and
// state.json. Only the Taiga client knows Taiga's names for them (`userstories`, `userstory-custom-attributes`, …).

export const ITEM_TYPES = ['epic', 'story', 'task'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

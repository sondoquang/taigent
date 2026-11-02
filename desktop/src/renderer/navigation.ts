// The navigation shell: one screen per section, switched from the rail `#nav`. Switching only shows and hides
// screens; the open project, the selected item and every draft stay as they are.

export const SECTIONS = ['backlog', 'wiki', 'taiga', 'changes', 'git', 'setup', 'settings'] as const;
export type Section = (typeof SECTIONS)[number];

let current: Section = 'backlog';
const listeners = new Set<(section: Section) => void>();

function isSection(value: string | undefined): value is Section {
  return SECTIONS.some((section) => section === value);
}

export function currentSection(): Section {
  return current;
}

export function showSection(section: Section): void {
  current = section;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#nav [data-section]')) {
    const on = button.dataset.section === section;
    button.classList.toggle('active', on);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const name of SECTIONS) {
    const screen = document.getElementById(`screen-${name}`);
    if (screen) screen.hidden = name !== section;
  }
  for (const listener of listeners) listener(section);
}

/** Calls `listener` after every switch, with the section now shown. */
export function onSectionChange(listener: (section: Section) => void): void {
  listeners.add(listener);
}

export function wireNavigation(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#nav [data-section]')) {
    const section = button.dataset.section;
    if (isSection(section)) button.addEventListener('click', () => showSection(section));
  }
  showSection(current);
}

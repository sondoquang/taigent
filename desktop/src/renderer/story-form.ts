// The parts of the story form (forms.ts) that only a story has: the use case (As a / I want to / so that) and the
// scenario editor of the user story format, the acceptance criteria of a legacy story with its "Chuyển sang user
// story format" action, and the live preview. The preview runs the core story template (`src/story-template.ts`,
// the one apply and `taigent preview` use) on exactly the fields the form saves, then the review screen's renderer
// (marked + DOMPurify, markdown.ts).
//
// Every part carries `data-path`, its path under the story in backlog.yaml (`scenarios[1].when`), so forms.ts shows
// an issue of the edit API next to the input it names.

import type { Scenario, UseCase } from '../../../src/manifest/backlog.ts';
import { storyDescription } from '../../../src/story-template.ts';
import { h } from './dom.ts';
import { renderMarkdown } from './markdown.ts';

/** A story's format fields as the form saves them (`StoryFields` of the edit API). */
export type StoryFormat = { useCase: UseCase; scenarios: Scenario[] } | { acceptanceCriteria: string[] };

export interface StoryEditor {
  /** The format section: use case + scenarios, or the legacy acceptance criteria. */
  element: HTMLElement;
  /** The live preview, refreshed by `refresh`. */
  preview: HTMLElement;
  format(): StoryFormat;
  /** Renders the preview of the story with `description` and `spec` as the form saves them. */
  refresh(text: { description: string; spec: string }): void;
}

const EMPTY_SCENARIO: Scenario = { scenario: '', given: [''], when: '', then: '' };

function textInput(className: string, value: string, placeholder: string): HTMLInputElement {
  const input = h('input', { type: 'text', class: className, autocomplete: 'off', placeholder });
  input.value = value;
  return input;
}

/** One labelled input with its own error line; `path` is set now (use case) or by `renumber` (scenarios). */
function part(name: string, label: string, control: HTMLElement, path?: string): HTMLElement {
  return h(
    'div',
    { class: 'field story-part', 'data-part': name, ...(path !== undefined && { 'data-path': path }) },
    h('span', { class: 'field-label' }, label),
    control,
    h('p', { class: 'field-error', hidden: true }),
  );
}

const values = (root: HTMLElement, selector: string) => [...root.querySelectorAll<HTMLInputElement>(selector)].map((input) => input.value.trim());

/** A button removing `target` from the form, then running `after`. */
function removeButton(target: HTMLElement, action: string, label: string, title: string, after: () => void): HTMLButtonElement {
  const remove = () => {
    target.remove();
    after();
  };
  return h('button', { type: 'button', class: 'btn small ghost', 'data-action': action, title, onclick: remove }, label);
}

/**
 * The story form's format section and preview. `initial` is the story as read from backlog.yaml (absent for a new
 * story, which always uses the user story format); `onChange` runs after a change that fires no `input` event
 * (adding, removing, moving, converting).
 */
export function storyEditor(initial: StoryFormat | undefined, onChange: () => void): StoryEditor {
  const element = h('div', { id: 'story-format' });
  const body = h('div', { class: 'markdown', id: 'form-preview-body' });
  const source = h('pre', { class: 'detail-text', id: 'form-preview-source' });
  const preview = h(
    'aside',
    { class: 'form-preview', id: 'form-preview' },
    h('h3', {}, 'Xem trước'),
    h('p', { class: 'hint' }, 'Mô tả đúng như apply sẽ ghi lên Taiga (cùng mẫu với taigent preview).'),
    body,
    h('details', {}, h('summary', {}, 'Markdown'), source),
  );
  let legacy = initial !== undefined && 'acceptanceCriteria' in initial;

  // ---- user story format ----

  const scenarioList = h('div', { class: 'scenario-list' });

  /** Sets each card's title, paths and button states from its position. */
  const renumber = () => {
    const cards = [...scenarioList.querySelectorAll<HTMLElement>(':scope > .scenario')];
    cards.forEach((card, i) => {
      card.dataset.path = `scenarios[${i}]`;
      card.querySelector('.scenario-title')!.textContent = `Scenario ${i + 1}`;
      for (const piece of card.querySelectorAll<HTMLElement>('[data-part]')) piece.dataset.path = `scenarios[${i}].${piece.dataset.part}`;
      card.querySelector<HTMLButtonElement>('[data-action="up"]')!.disabled = i === 0;
      card.querySelector<HTMLButtonElement>('[data-action="down"]')!.disabled = i === cards.length - 1;
      card.querySelector<HTMLButtonElement>('[data-action="remove-scenario"]')!.disabled = cards.length === 1;
      const givens = card.querySelectorAll<HTMLButtonElement>('[data-action="remove-given"]');
      for (const button of givens) button.disabled = givens.length === 1;
    });
  };
  const changed = () => {
    renumber();
    onChange();
  };

  const givenRow = (value: string): HTMLElement => {
    const row = h('div', { class: 'list-row' }, textInput('scenario-given', value, 'Bối cảnh trước khi làm'));
    row.append(removeButton(row, 'remove-given', '×', 'Xoá Given này', changed));
    return row;
  };

  const scenarioCard = (scenario: Scenario): HTMLElement => {
    const givens = h('div', { class: 'given-list' }, ...(scenario.given.length > 0 ? scenario.given : ['']).map(givenRow));
    const card = h('div', { class: 'scenario' });
    const move = (up: boolean) => {
      const other = up ? card.previousElementSibling : card.nextElementSibling;
      if (!other) return;
      if (up) other.before(card);
      else other.after(card);
      changed();
    };
    card.append(
      h(
        'div',
        { class: 'scenario-head' },
        h('strong', { class: 'scenario-title' }),
        h('button', { type: 'button', class: 'btn small ghost', 'data-action': 'up', title: 'Chuyển lên', onclick: () => move(true) }, '↑'),
        h('button', { type: 'button', class: 'btn small ghost', 'data-action': 'down', title: 'Chuyển xuống', onclick: () => move(false) }, '↓'),
        removeButton(card, 'remove-scenario', 'Xoá scenario', 'Xoá scenario này', changed),
      ),
      part('scenario', 'Tên scenario', textInput('scenario-name', scenario.scenario, 'Ví dụ: Sai mật khẩu')),
      part(
        'given',
        'Given (một hoặc nhiều)',
        h(
          'div',
          {},
          givens,
          h('button', {
            type: 'button',
            class: 'btn small',
            'data-action': 'add-given',
            onclick: () => {
              const row = givenRow('');
              givens.append(row);
              changed();
              row.querySelector('input')!.focus();
            },
          }, '+ Given'),
        ),
      ),
      part('when', 'When', textInput('scenario-when', scenario.when, 'Hành động')),
      part('then', 'Then', textInput('scenario-then', scenario.then, 'Kết quả mong đợi')),
      h('p', { class: 'field-error', hidden: true }),
    );
    return card;
  };

  const userStorySection = (useCase: UseCase, scenarios: Scenario[], converted: boolean): HTMLElement[] => {
    scenarioList.replaceChildren(...(scenarios.length > 0 ? scenarios : [EMPTY_SCENARIO]).map(scenarioCard));
    renumber();
    const notice = h(
      'p',
      { class: 'warn-box', id: 'story-converted' },
      'Đã chuyển sang user story format: điền As a / I want to / so that và Given/When/Then của từng scenario (tên scenario lấy từ tiêu chí cũ). Khi lưu, acceptance_criteria được thay bằng use_case + scenarios, và Xem thay đổi trên Taiga sẽ báo cập nhật description của story.',
    );
    return [
      ...(converted ? [notice] : []),
      h(
        'fieldset',
        { class: 'field story-box', 'data-path': 'use_case', 'data-field': 'use_case' },
        h('legend', {}, 'User story'),
        part('as_a', 'As a', h('input', { type: 'text', id: 'story-as-a', autocomplete: 'off', value: useCase.asA, placeholder: 'Vai trò của người dùng' }), 'use_case.as_a'),
        part('i_want_to', 'I want to', h('input', { type: 'text', id: 'story-i-want-to', autocomplete: 'off', value: useCase.iWantTo, placeholder: 'Việc người đó muốn làm' }), 'use_case.i_want_to'),
        part('so_that', 'so that', h('input', { type: 'text', id: 'story-so-that', autocomplete: 'off', value: useCase.soThat, placeholder: 'Lợi ích nhận được' }), 'use_case.so_that'),
        h('p', { class: 'field-error', hidden: true }),
      ),
      h(
        'fieldset',
        { class: 'field story-box', 'data-path': 'scenarios', 'data-field': 'scenarios' },
        h('legend', {}, 'Tiêu chí chấp nhận (scenario Gherkin)'),
        scenarioList,
        h('button', {
          type: 'button',
          class: 'btn small',
          id: 'story-add-scenario',
          onclick: () => {
            const card = scenarioCard(EMPTY_SCENARIO);
            scenarioList.append(card);
            changed();
            card.querySelector('input')!.focus();
          },
        }, '+ Scenario'),
        h('p', { class: 'field-error', hidden: true }),
      ),
    ];
  };

  // ---- legacy format ----

  const criterionRow = (value: string): HTMLElement => {
    const row = h('div', { class: 'list-row' }, textInput('criterion', value, 'Một tiêu chí chấp nhận'));
    row.append(removeButton(row, 'remove-criterion', '×', 'Xoá tiêu chí này', onChange));
    return row;
  };

  const legacySection = (criteria: string[]): HTMLElement[] => {
    const list = h('div', { class: 'criteria-list' }, ...criteria.map(criterionRow));
    return [
      h(
        'fieldset',
        { class: 'field story-box', 'data-path': 'acceptance_criteria', 'data-field': 'acceptance_criteria' },
        h('legend', {}, 'Tiêu chí chấp nhận (legacy)'),
        h(
          'p',
          { class: 'hint' },
          'Story này dùng legacy format (description + acceptance_criteria), chỉ được giữ cho story đã có trên Taiga. Sửa ở đây không đổi format.',
        ),
        list,
        h('button', {
          type: 'button',
          class: 'btn small',
          id: 'story-add-criterion',
          onclick: () => {
            const row = criterionRow('');
            list.append(row);
            onChange();
            row.querySelector('input')!.focus();
          },
        }, '+ Tiêu chí'),
        h('p', { class: 'field-error', hidden: true }),
        h('div', { class: 'convert' }, h('button', { type: 'button', class: 'btn', id: 'story-convert', onclick: () => convert() }, 'Chuyển sang user story format')),
      ),
    ];
  };

  /** Legacy → user story format, on the user's request: each criterion becomes a scenario to complete. */
  const convert = () => {
    const criteria = values(element, '.criterion').filter(Boolean);
    legacy = false;
    element.dataset.format = 'user-story';
    element.replaceChildren(
      ...userStorySection(
        { asA: '', iWantTo: '', soThat: '' },
        criteria.map((criterion) => ({ ...EMPTY_SCENARIO, scenario: criterion })),
        true,
      ),
    );
    onChange();
    element.querySelector<HTMLInputElement>('#story-as-a')!.focus();
  };

  element.dataset.format = legacy ? 'legacy' : 'user-story';
  if (initial !== undefined && 'acceptanceCriteria' in initial) element.replaceChildren(...legacySection(initial.acceptanceCriteria));
  else element.replaceChildren(...userStorySection(initial?.useCase ?? { asA: '', iWantTo: '', soThat: '' }, initial?.scenarios ?? [], false));

  const format = (): StoryFormat => {
    if (legacy) return { acceptanceCriteria: values(element, '.criterion').filter(Boolean) };
    const field = (id: string) => element.querySelector<HTMLInputElement>(`#${id}`)!.value.trim();
    return {
      useCase: { asA: field('story-as-a'), iWantTo: field('story-i-want-to'), soThat: field('story-so-that') },
      scenarios: [...scenarioList.querySelectorAll<HTMLElement>(':scope > .scenario')].map((card) => ({
        scenario: values(card, '.scenario-name')[0]!,
        given: values(card, '.scenario-given').filter(Boolean),
        when: values(card, '.scenario-when')[0]!,
        then: values(card, '.scenario-then')[0]!,
      })),
    };
  };

  return {
    element,
    preview,
    format,
    refresh({ description, spec }) {
      const current = format();
      const text = storyDescription(
        'acceptanceCriteria' in current ? { format: 'legacy', ...current, description, spec } : { format: 'user-story', ...current, description, spec },
      );
      source.textContent = text;
      if (text.trim()) body.replaceChildren(renderMarkdown(text));
      else body.replaceChildren(h('p', { class: 'muted' }, '(không có mô tả)'));
    },
  };
}

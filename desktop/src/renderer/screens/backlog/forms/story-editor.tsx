// The parts of the story form (item-form.tsx) that only a story has: the use case (As a / I want to / so that) and the
// scenario editor of the user story format, and the acceptance criteria of a legacy story with its "Chuyển sang user
// story format" action. The live preview runs the core story template (`src/story-template.ts`, the one apply and
// `taigent preview` use) on exactly the fields the form saves (`storyFormat`), rendered like the review screen.
//
// Every part carries `data-path`, its path under the story in backlog.yaml (`scenarios[1].when`), and shows the
// errors of that path. A scenario's errors are kept under its card id (`s7.when`, see `storyErrorKeys`), so they move
// with the card when scenarios are moved or removed.

import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useState } from 'react';
import type { StoryFields } from '../../../../../../src/edit.ts';
import type { Scenario, UseCase } from '../../../../../../src/manifest/backlog.ts';
import { Button } from '@/components/ui/button.tsx';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, FieldTitle } from '@/components/ui/field.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';

interface ScenarioDraft extends Scenario {
  /** Stable identity of the card across moves and removals. */
  id: number;
}

/** The story's format section as edited: the user story format, or the legacy acceptance criteria. */
export type StoryDraft =
  | { format: 'user-story'; useCase: UseCase; scenarios: ScenarioDraft[]; converted: boolean }
  | { format: 'legacy'; criteria: string[] };

/** A story's format fields as the form saves them (`StoryFields` of the edit API). */
export type StoryFormat = Required<Pick<StoryFields, 'useCase' | 'scenarios'>> | Required<Pick<StoryFields, 'acceptanceCriteria'>>;

const EMPTY_USE_CASE: UseCase = { asA: '', iWantTo: '', soThat: '' };

let cards = 0;

function scenarioDraft(scenario: Partial<Scenario> = {}): ScenarioDraft {
  cards += 1;
  const given = scenario.given && scenario.given.length > 0 ? scenario.given : [''];
  return { id: cards, scenario: scenario.scenario ?? '', given, when: scenario.when ?? '', then: scenario.then ?? '' };
}

/** The draft of a story as read from backlog.yaml; a new story (or one without either format) uses the user story format. */
export function initialStory(stored: StoryFields | undefined): StoryDraft {
  if (stored?.acceptanceCriteria) return { format: 'legacy', criteria: stored.acceptanceCriteria };
  const scenarios = stored?.useCase ? (stored.scenarios ?? []) : [];
  return {
    format: 'user-story',
    useCase: stored?.useCase ?? EMPTY_USE_CASE,
    scenarios: (scenarios.length > 0 ? scenarios : [{}]).map(scenarioDraft),
    converted: false,
  };
}

/** The format fields the save sends: trimmed, empty Given and criteria left out. */
export function storyFormat(draft: StoryDraft): StoryFormat {
  if (draft.format === 'legacy') return { acceptanceCriteria: draft.criteria.map((criterion) => criterion.trim()).filter(Boolean) };
  const { asA, iWantTo, soThat } = draft.useCase;
  return {
    useCase: { asA: asA.trim(), iWantTo: iWantTo.trim(), soThat: soThat.trim() },
    scenarios: draft.scenarios.map((card) => ({
      scenario: card.scenario.trim(),
      given: card.given.map((given) => given.trim()).filter(Boolean),
      when: card.when.trim(),
      then: card.then.trim(),
    })),
  };
}

const SCENARIO_PARTS = ['scenario', 'given', 'when', 'then'] as const;

/** Each path a story part shows errors for, with the key its error is kept under. */
export function storyErrorKeys(draft: StoryDraft): Map<string, string> {
  if (draft.format === 'legacy') return new Map([['acceptance_criteria', 'acceptance_criteria']]);
  const keys = new Map(['use_case', 'use_case.as_a', 'use_case.i_want_to', 'use_case.so_that', 'scenarios'].map((path) => [path, path]));
  draft.scenarios.forEach((card, i) => {
    keys.set(`scenarios[${i}]`, `s${card.id}`);
    for (const part of SCENARIO_PARTS) keys.set(`scenarios[${i}].${part}`, `s${card.id}.${part}`);
  });
  return keys;
}

/** An icon button with its label as tooltip and accessible name. */
function IconButton({ action, label, disabled, onClick, children }: { action: string; label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" data-action={action} aria-label={label} disabled={disabled} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One labelled part with its own error line; `path` is its path under the story. */
function Part({ name, path, label, htmlFor, error, children }: { name: string; path: string; label: string; htmlFor?: string; error?: string; children: React.ReactNode }) {
  return (
    <Field className="field story-part gap-2" data-part={name} data-path={path} data-invalid={error ? true : undefined}>
      {htmlFor ? <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel> : <FieldTitle>{label}</FieldTitle>}
      {children}
      {error && <FieldError className="field-error">{error}</FieldError>}
    </Field>
  );
}

const BOX = 'field story-box rounded-lg border bg-card p-4';

/**
 * The story form's format section. `onChange` gets the new draft after every edit; `errors` are keyed as
 * `storyErrorKeys` names them.
 */
export function StoryEditor({ draft, onChange, errors }: { draft: StoryDraft; onChange: (draft: StoryDraft) => void; errors: Record<string, string> }) {
  // The input a click just created (a Given, a scenario, a criterion, the use case after converting) takes the focus.
  const [focus, setFocus] = useState<string>();

  if (draft.format === 'legacy') {
    const setCriteria = (criteria: string[]) => onChange({ format: 'legacy', criteria });
    // Legacy → user story format, on the user's request: each criterion becomes a scenario to complete.
    const convert = () => {
      const criteria = draft.criteria.map((criterion) => criterion.trim()).filter(Boolean);
      onChange({
        format: 'user-story',
        useCase: EMPTY_USE_CASE,
        scenarios: (criteria.length > 0 ? criteria.map((scenario) => ({ scenario })) : [{}]).map(scenarioDraft),
        converted: true,
      });
      setFocus('as-a');
    };
    return (
      <div id="story-format" data-format="legacy" className="flex flex-col gap-6">
        <FieldSet className={BOX} data-path="acceptance_criteria" data-field="acceptance_criteria">
          <FieldLegend variant="label">Tiêu chí chấp nhận (legacy)</FieldLegend>
          <FieldDescription>
            Story này dùng legacy format (description + acceptance_criteria), chỉ được giữ cho story đã có trên Taiga. Sửa ở đây không đổi format.
          </FieldDescription>
          <div className="criteria-list flex flex-col gap-2">
            {draft.criteria.map((criterion, i) => (
              <div key={i} className="list-row flex items-center gap-2">
                <Input
                  className="criterion"
                  autoComplete="off"
                  placeholder="Một tiêu chí chấp nhận"
                  aria-label={`Tiêu chí ${i + 1}`}
                  autoFocus={focus === `criterion-${i}`}
                  value={criterion}
                  onChange={(event) => setCriteria(draft.criteria.map((value, j) => (j === i ? event.target.value : value)))}
                />
                <IconButton action="remove-criterion" label="Xoá tiêu chí này" onClick={() => setCriteria(draft.criteria.filter((_, j) => j !== i))}>
                  <X aria-hidden />
                </IconButton>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              id="story-add-criterion"
              onClick={() => {
                setFocus(`criterion-${draft.criteria.length}`);
                setCriteria([...draft.criteria, '']);
              }}
            >
              + Tiêu chí
            </Button>
          </div>
          {errors.acceptance_criteria && <FieldError className="field-error">{errors.acceptance_criteria}</FieldError>}
          <div className="convert">
            <Button type="button" variant="secondary" id="story-convert" onClick={convert}>
              Chuyển sang user story format
            </Button>
          </div>
        </FieldSet>
      </div>
    );
  }

  const setUseCase = (change: Partial<UseCase>) => onChange({ ...draft, useCase: { ...draft.useCase, ...change } });
  const setScenarios = (scenarios: ScenarioDraft[]) => onChange({ ...draft, scenarios });
  const setCard = (id: number, change: Partial<Scenario>) => setScenarios(draft.scenarios.map((card) => (card.id === id ? { ...card, ...change } : card)));
  const moveCard = (i: number, step: -1 | 1) => {
    const scenarios = [...draft.scenarios];
    const [card] = scenarios.splice(i, 1);
    if (!card) return;
    scenarios.splice(i + step, 0, card);
    setScenarios(scenarios);
  };
  const useCaseParts = [
    { name: 'as_a', id: 'story-as-a', label: 'As a', field: 'asA', placeholder: 'Vai trò của người dùng' },
    { name: 'i_want_to', id: 'story-i-want-to', label: 'I want to', field: 'iWantTo', placeholder: 'Việc người đó muốn làm' },
    { name: 'so_that', id: 'story-so-that', label: 'so that', field: 'soThat', placeholder: 'Lợi ích nhận được' },
  ] as const;

  return (
    <div id="story-format" data-format="user-story" className="flex flex-col gap-6">
      {draft.converted && (
        <p id="story-converted" role="status" className="warn-box rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          Đã chuyển sang user story format: điền As a / I want to / so that và Given/When/Then của từng scenario (tên scenario lấy từ tiêu chí cũ). Khi
          lưu, acceptance_criteria được thay bằng use_case + scenarios, và Xem thay đổi trên Taiga sẽ báo cập nhật description của story.
        </p>
      )}
      <FieldSet className={cn(BOX, 'gap-4')} data-path="use_case" data-field="use_case">
        <FieldLegend variant="label">User story</FieldLegend>
        {useCaseParts.map((part) => (
          <Part key={part.name} name={part.name} path={`use_case.${part.name}`} label={part.label} htmlFor={part.id} error={errors[`use_case.${part.name}`]}>
            <Input
              id={part.id}
              autoComplete="off"
              placeholder={part.placeholder}
              autoFocus={part.name === 'as_a' && focus === 'as-a'}
              aria-invalid={errors[`use_case.${part.name}`] ? true : undefined}
              value={draft.useCase[part.field]}
              onChange={(event) => setUseCase({ [part.field]: event.target.value })}
            />
          </Part>
        ))}
        {errors.use_case && <FieldError className="field-error">{errors.use_case}</FieldError>}
      </FieldSet>
      <FieldSet className={cn(BOX, 'gap-4')} data-path="scenarios" data-field="scenarios">
        <FieldLegend variant="label">Tiêu chí chấp nhận (scenario Gherkin)</FieldLegend>
        <div className="scenario-list flex flex-col gap-4">
          {draft.scenarios.map((card, i) => {
            const error = (part: string) => errors[`s${card.id}.${part}`];
            const inputId = (part: string) => `story-s${card.id}-${part}`;
            return (
              <div key={card.id} className="scenario flex flex-col gap-3 rounded-md border bg-background p-3" data-path={`scenarios[${i}]`}>
                <div className="scenario-head flex items-center gap-1">
                  <strong className="scenario-title mr-auto text-sm font-semibold">Scenario {i + 1}</strong>
                  <IconButton action="up" label="Chuyển lên" disabled={i === 0} onClick={() => moveCard(i, -1)}>
                    <ArrowUp aria-hidden />
                  </IconButton>
                  <IconButton action="down" label="Chuyển xuống" disabled={i === draft.scenarios.length - 1} onClick={() => moveCard(i, 1)}>
                    <ArrowDown aria-hidden />
                  </IconButton>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-action="remove-scenario"
                    title="Xoá scenario này"
                    disabled={draft.scenarios.length === 1}
                    onClick={() => setScenarios(draft.scenarios.filter((other) => other.id !== card.id))}
                  >
                    Xoá scenario
                  </Button>
                </div>
                <Part name="scenario" path={`scenarios[${i}].scenario`} label="Tên scenario" htmlFor={inputId('name')} error={error('scenario')}>
                  <Input
                    id={inputId('name')}
                    className="scenario-name"
                    autoComplete="off"
                    placeholder="Ví dụ: Sai mật khẩu"
                    autoFocus={focus === `scenario-${card.id}`}
                    aria-invalid={error('scenario') ? true : undefined}
                    value={card.scenario}
                    onChange={(event) => setCard(card.id, { scenario: event.target.value })}
                  />
                </Part>
                <Part name="given" path={`scenarios[${i}].given`} label="Given (một hoặc nhiều)" error={error('given')}>
                  <div className="given-list flex flex-col gap-2">
                    {card.given.map((given, j) => (
                      <div key={j} className="list-row flex items-center gap-2">
                        <Input
                          className="scenario-given"
                          autoComplete="off"
                          placeholder="Bối cảnh trước khi làm"
                          aria-label={`Given ${j + 1} của scenario ${i + 1}`}
                          autoFocus={focus === `given-${card.id}-${j}`}
                          aria-invalid={error('given') ? true : undefined}
                          value={given}
                          onChange={(event) => setCard(card.id, { given: card.given.map((value, k) => (k === j ? event.target.value : value)) })}
                        />
                        <IconButton
                          action="remove-given"
                          label="Xoá Given này"
                          disabled={card.given.length === 1}
                          onClick={() => setCard(card.id, { given: card.given.filter((_, k) => k !== j) })}
                        >
                          <X aria-hidden />
                        </IconButton>
                      </div>
                    ))}
                    <div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-action="add-given"
                        onClick={() => {
                          setFocus(`given-${card.id}-${card.given.length}`);
                          setCard(card.id, { given: [...card.given, ''] });
                        }}
                      >
                        + Given
                      </Button>
                    </div>
                  </div>
                </Part>
                <Part name="when" path={`scenarios[${i}].when`} label="When" htmlFor={inputId('when')} error={error('when')}>
                  <Input
                    id={inputId('when')}
                    className="scenario-when"
                    autoComplete="off"
                    placeholder="Hành động"
                    aria-invalid={error('when') ? true : undefined}
                    value={card.when}
                    onChange={(event) => setCard(card.id, { when: event.target.value })}
                  />
                </Part>
                <Part name="then" path={`scenarios[${i}].then`} label="Then" htmlFor={inputId('then')} error={error('then')}>
                  <Input
                    id={inputId('then')}
                    className="scenario-then"
                    autoComplete="off"
                    placeholder="Kết quả mong đợi"
                    aria-invalid={error('then') ? true : undefined}
                    value={card.then}
                    onChange={(event) => setCard(card.id, { then: event.target.value })}
                  />
                </Part>
                {errors[`s${card.id}`] && <FieldError className="field-error">{errors[`s${card.id}`]}</FieldError>}
              </div>
            );
          })}
        </div>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            id="story-add-scenario"
            onClick={() => {
              const card = scenarioDraft();
              setFocus(`scenario-${card.id}`);
              setScenarios([...draft.scenarios, card]);
            }}
          >
            + Scenario
          </Button>
        </div>
        {errors.scenarios && <FieldError className="field-error">{errors.scenarios}</FieldError>}
      </FieldSet>
    </div>
  );
}

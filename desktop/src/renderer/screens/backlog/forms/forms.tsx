// The Backlog forms as the Backlog screen places them: the item detail's actions (edit, add a story or a task,
// remove), the "+ Epic" and "+ Issue" buttons, and `BacklogForms` — the item form (item-form.tsx) and the removal
// warning for items already on Taiga, rendered once. What is open lives in forms-store.ts.

import { useState } from 'react';
import type { PreviewItem } from '../../../../shared/api.ts';
import { Code } from '@/components/common.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog } from '@/components/ui/dialog.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { closeForm, closeRemoval, confirmRemove, openForm, removeItem, useForms } from './forms-store.ts';
import { ItemForm } from './item-form.tsx';

/** A small button whose async action (reading backlog.yaml before a form opens) disables it with a spinner. */
function ActionButton({ run, variant = 'outline', children, ...props }: { run: () => Promise<void>; variant?: 'outline' | 'ghost'; children: string; id?: string; 'data-action'?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() => {
        setPending(true);
        void run().finally(() => setPending(false));
      }}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </Button>
  );
}

/** The item detail's buttons: Sửa, + Story (epic), + Task (story), Xoá. */
export function ItemActions({ item }: { item: PreviewItem }) {
  return (
    <div className="item-actions flex flex-wrap gap-2">
      <ActionButton data-action="edit" run={() => openForm(item.type, item)}>
        Sửa
      </ActionButton>
      {item.type === 'epic' && (
        <ActionButton data-action="add-story" run={() => openForm('story', undefined, item.key)}>
          + Story
        </ActionButton>
      )}
      {item.type === 'story' && (
        <ActionButton data-action="add-task" run={() => openForm('task', undefined, item.key)}>
          + Task
        </ActionButton>
      )}
      <ActionButton data-action="remove" variant="ghost" run={() => confirmRemove(item)}>
        Xoá
      </ActionButton>
    </div>
  );
}

/** "+ Epic", above the tree. */
export function AddEpicButton() {
  return (
    <ActionButton id="add-epic" run={() => openForm('epic')}>
      + Epic
    </ActionButton>
  );
}

/** "+ Issue", in the tree's Issues group: issues sit outside the epic tree. */
export function AddIssueButton() {
  return (
    <ActionButton id="add-issue" run={() => openForm('issue')}>
      + Issue
    </ActionButton>
  );
}

/** The removal warning: what goes with the item, and which items already on Taiga become orphans there. */
function RemoveDialog() {
  const removal = useForms((state) => state.removal);
  const children = removal?.removed.slice(1) ?? [];
  const onTaiga = removal?.removed.filter((candidate) => candidate.applied !== undefined) ?? [];
  return (
    <AlertDialog open={removal !== undefined} onOpenChange={(open) => !open && closeRemoval()}>
      <AlertDialogContent id="remove-dialog">
        {removal && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Xoá {removal.item.type} {removal.item.key}?
              </AlertDialogTitle>
              <AlertDialogDescription className="break-words">“{removal.item.subject}” sẽ bị xoá khỏi backlog.yaml.</AlertDialogDescription>
            </AlertDialogHeader>
            {children.length > 0 && (
              <p className="text-sm break-words">
                Kèm theo {children.length} mục bên dưới: <Code>{children.map((child) => child.key).join(', ')}</Code>.
              </p>
            )}
            {onTaiga.length > 0 && (
              <div id="remove-orphans" role="alert" className="warn-box rounded-md border border-warning-border bg-warning-bg p-3 text-sm break-words text-warning">
                <strong className="font-medium">Mục đã có trên Taiga sẽ thành mồ côi. </strong>
                {`Xoá khỏi manifest không xoá chúng trên Taiga: ${onTaiga.map((candidate) => `${candidate.key} (#${candidate.applied!.ref})`).join(', ')} vẫn còn đó, và “Xem thay đổi trên Taiga” sẽ báo chúng là mồ côi để người quyết định.`}
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel id="remove-cancel">Huỷ</AlertDialogCancel>
              <AlertDialogAction
                id="remove-confirm"
                variant="destructive"
                onClick={() => {
                  closeRemoval();
                  void removeItem(removal.slug, removal.item, removal.base);
                }}
              >
                Xoá khỏi backlog
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The item form and the removal dialog; rendered once by the Backlog screen. */
export function BacklogForms() {
  const form = useForms((state) => state.form);
  return (
    <>
      <Dialog open={form !== undefined} onOpenChange={(open) => !open && closeForm()}>
        {form && <ItemForm key={form.id} form={form} />}
      </Dialog>
      <RemoveDialog />
    </>
  );
}

// The conflict dialog of the forms (Backlog item forms, Wiki page form): the file changed on disk since the form
// opened (an agent edited it). Shows the lines removed and added; "Áp lại thay đổi của tôi" runs `reapply` on the new
// version. Mounted once in App; opened with showConflict().

import { create } from 'zustand';
import type { ManifestFile } from '../../shared/api.ts';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { changeHunks, lineDiff } from '@/lib/diff.ts';
import { cn } from '@/lib/utils.ts';

interface Conflict {
  base: ManifestFile;
  current: ManifestFile;
  reapply: () => void;
  name: string;
}

const useConflict = create<{ conflict?: Conflict }>(() => ({}));

/** Shows what changed in `name` (backlog.yaml by default) since `base`, with "Áp lại" running `reapply`. */
export function showConflict(base: ManifestFile, current: ManifestFile, reapply: () => void, name = 'backlog.yaml'): void {
  useConflict.setState({ conflict: { base, current, reapply, name } });
}

const close = () => useConflict.setState({ conflict: undefined });

export function ConflictDialog() {
  const conflict = useConflict((state) => state.conflict);
  const hunks = conflict ? changeHunks(lineDiff(conflict.base.text, conflict.current.text)) : [];
  return (
    <Dialog open={conflict !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent id="conflict-dialog" className="sm:max-w-3xl">
        {conflict && (
          <>
            <DialogHeader>
              <DialogTitle>{conflict.name} đã đổi từ lúc bạn mở form</DialogTitle>
              <DialogDescription>
                Chưa có gì được ghi. Có người (thường là agent) vừa sửa file. Xem thay đổi dưới đây; bấm "Áp lại thay đổi của tôi" để ghi phần
                của bạn lên bản mới, hoặc Huỷ để giữ nguyên.
              </DialogDescription>
            </DialogHeader>
            {hunks.length === 0 ? (
              <p className="text-muted-foreground">Nội dung giống nhau, chỉ khác cách xuống dòng.</p>
            ) : (
              <pre id="conflict-diff" className="diff max-h-[50vh] overflow-auto rounded-md border bg-muted/50 p-2 text-xs leading-relaxed">
                {hunks.map((line, index) =>
                  line === undefined ? (
                    <span key={index} className="diff-gap block text-muted-foreground">
                      …
                    </span>
                  ) : (
                    <span
                      key={index}
                      className={cn(
                        `diff-${line.kind}`,
                        'block whitespace-pre-wrap',
                        line.kind === 'added' && 'bg-success/10 text-success',
                        line.kind === 'removed' && 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {`${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} ${line.text}\n`}
                    </span>
                  ),
                )}
              </pre>
            )}
            <DialogFooter>
              <Button id="conflict-cancel" variant="outline" onClick={close}>
                Huỷ
              </Button>
              <Button
                id="conflict-reapply"
                onClick={() => {
                  close();
                  conflict.reapply();
                }}
              >
                Áp lại thay đổi của tôi
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

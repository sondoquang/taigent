import { closeResult } from '@/actions.ts';
import { FailureBlock } from '@/components/failure-block.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx';
import { useApp } from '@/store.ts';

/** The modal result of showResult(): a read failure, an invalid manifest… */
export function ResultDialog() {
  const result = useApp((state) => state.result);
  return (
    <Dialog open={result !== undefined} onOpenChange={(open) => !open && closeResult()}>
      <DialogContent id="result-dialog" className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{result?.title}</DialogTitle>
          <DialogDescription className="sr-only">Kết quả</DialogDescription>
        </DialogHeader>
        <div id="result-content" className="max-h-[60vh] min-w-0 overflow-auto">
          {result?.failure ? <FailureBlock failure={result.failure} /> : result?.content}
        </div>
        <DialogFooter>
          <Button id="result-close" variant="outline" onClick={closeResult}>
            Đóng
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

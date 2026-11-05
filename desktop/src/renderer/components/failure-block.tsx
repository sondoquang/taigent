import { CircleAlert } from 'lucide-react';
import type { Failure } from '../../shared/api.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';

/** A failure as the CLI or the main process reported it: the Vietnamese message, the CLI's text, the manifest issues. */
export function FailureBlock({ failure }: { failure: Failure }) {
  return (
    <Alert variant="destructive" className="failure">
      <CircleAlert />
      <AlertTitle className="error line-clamp-none whitespace-pre-wrap">{failure.message}</AlertTitle>
      {(failure.detail || (failure.issues && failure.issues.length > 0)) && (
        <AlertDescription className="min-w-0">
          {failure.detail && (
            <pre className="detail-text max-h-64 w-full overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap text-foreground">
              {failure.detail}
            </pre>
          )}
          {failure.issues && failure.issues.length > 0 && (
            <ul className="issues list-disc space-y-1 pl-4">
              {failure.issues.map((issue, index) => (
                <li key={index}>
                  <code className="text-foreground">
                    {issue.file}
                    {issue.path ? ` › ${issue.path}` : ''}
                  </code>{' '}
                  {issue.message} <span className="text-muted-foreground">[{issue.rule}]</span>
                </li>
              ))}
            </ul>
          )}
        </AlertDescription>
      )}
    </Alert>
  );
}

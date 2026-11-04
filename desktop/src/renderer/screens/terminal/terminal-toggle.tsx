// The top-bar button that shows or hides the terminal dock (terminal-dock.tsx); Ctrl+` does the same.

import { Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx';
import { cn } from '@/lib/utils.ts';
import { setShown, useTerminal } from '@/screens/terminal/terminal-store.ts';

export function TerminalToggle() {
  const shown = useTerminal((state) => state.shown);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          id="terminal-toggle"
          variant="ghost"
          size="sm"
          aria-controls="terminal-dock"
          aria-expanded={shown}
          className={cn(shown && 'active bg-accent text-accent-foreground')}
          onClick={() => setShown(!shown)}
        >
          <TerminalIcon aria-hidden="true" />
          Terminal
        </Button>
      </TooltipTrigger>
      <TooltipContent>Terminal (Ctrl+`)</TooltipContent>
    </Tooltip>
  );
}

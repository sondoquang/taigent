// Terminal prompts of `taigent login`. Only a terminal is accepted: a piped stdin would let a script or an agent
// type the password, and it would then sit in a command line or a transcript.

import { createInterface } from 'node:readline/promises';

/** The user cancelled a prompt (Ctrl+C / Ctrl+D). */
export class PromptCancelled extends Error {}

export function isTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads one line without echoing it (raw mode); Backspace edits, Ctrl+C or Ctrl+D cancels. */
export function askHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value: string[] = [];
  const finish = (settle: () => void) => {
    stdin.off('data', onData);
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
    settle();
  };
  function onData(chunk: string): void {
    for (const char of chunk) {
      if (char === '\r' || char === '\n') return finish(() => resolve(value.join('')));
      if (char === '\u0003' || (char === '\u0004' && value.length === 0)) return finish(() => reject(new PromptCancelled('cancelled')));
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else if (char >= ' ') value.push(char);
    }
  }
  stdin.on('data', onData);
  return promise;
}

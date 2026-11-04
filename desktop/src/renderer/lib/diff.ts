// Line diff for the conflict dialog: what changed in backlog.yaml between the file a form was opened on and the file
// now on disk.

export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** The lines of `before` and `after` aligned on a longest common subsequence. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const width = b.length + 1;
  // common[i * width + j]: length of the longest common subsequence of a[i..] and b[j..].
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i++]! });
      j++;
    } else if (i < a.length && (j === b.length || common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) {
      lines.push({ kind: 'removed', text: a[i++]! });
    } else {
      lines.push({ kind: 'added', text: b[j++]! });
    }
  }
  return lines;
}

/** The changed lines with `context` unchanged lines around each change; `undefined` stands for skipped lines. */
export function changeHunks(lines: readonly DiffLine[], context = 2): (DiffLine | undefined)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const hunks: (DiffLine | undefined)[] = [];
  lines.forEach((line, index) => {
    if (keep[index]) hunks.push(line);
    else if (hunks.length > 0 && hunks.at(-1) !== undefined) hunks.push(undefined);
  });
  if (hunks.at(-1) === undefined) hunks.pop();
  return hunks;
}

// Pieces every Role's dashboard uses: the widget card (its `id` is the stable hook of the smoke, ADR 0004), the stat
// row, the edge-to-edge table and the period label.

import type { ReactNode } from 'react';
import type { Period } from '../../../shared/api.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card.tsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.tsx';

/** A period as the dashboards name it: the sprint's name, or "Tuần <Monday>" for a week of a kanban project. */
export function periodLabel(period: Period): string {
  return period.id.startsWith('week:') ? `Tuần ${period.start}` : period.name;
}

/** Days as Vietnamese writes them (2,5 ngày). */
export function days(value: number): string {
  return `${value.toLocaleString('vi-VN')} ngày`;
}

/** A dashboard card: title, optional description, content. */
export function Widget({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} className="dashboard-widget min-w-0">
      <CardHeader>
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">{children}</CardContent>
    </Card>
  );
}

/** A row of StatCells, four across on a window. */
export function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{children}</div>;
}

export interface WidgetRow {
  key: string;
  /** `data-*` hooks of the row. */
  data: Record<string, string>;
  cells: ReactNode[];
}

/** An edge-to-edge table of a widget, or the `empty` sentence when it has no rows. */
export function WidgetTable({ head, rows, empty }: { head: string[]; rows: WidgetRow[]; empty: string }) {
  if (rows.length === 0) return <p className="empty text-muted-foreground">{empty}</p>;
  return (
    <div className="-mx-6">
      <Table>
        <TableHeader>
          <TableRow>
            {head.map((cell) => (
              <TableHead key={cell}>{cell}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key} {...row.data}>
              {row.cells.map((cell, column) => (
                <TableCell key={column} className="whitespace-normal break-words">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

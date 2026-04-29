import { ReactNode } from 'react';
import { AIExtractedBadge } from './AIExtractedBadge';

export interface LabelValueRow {
  label: string;
  value: ReactNode | string | number | null | undefined;
  /** Show the "AI extracted" pill next to the label. */
  aiExtracted?: boolean;
  /** Force the row to span both columns (e.g. for long text fields). */
  fullWidth?: boolean;
}

interface Props {
  rows: LabelValueRow[];
  /** Empty-state copy when no rows have a populated value. */
  emptyHint?: string;
}

const EMPTY_GLYPH = '—';

function formatValue(value: LabelValueRow['value']): ReactNode {
  if (value === null || value === undefined || value === '') return EMPTY_GLYPH;
  if (typeof value === 'string' && value.trim() === '') return EMPTY_GLYPH;
  return value;
}

function isEmpty(value: LabelValueRow['value']): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

export function LabelValueGrid({ rows, emptyHint }: Props) {
  const allEmpty = rows.every((r) => isEmpty(r.value));

  if (allEmpty && emptyHint) {
    return <p className="text-sm text-muted-foreground italic">{emptyHint}</p>;
  }

  return (
    <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
      {rows.map((row, idx) => (
        <div
          key={`${row.label}-${idx}`}
          className={row.fullWidth ? 'md:col-span-2' : undefined}
        >
          <dt className="flex items-center text-xs font-semibold text-foreground uppercase tracking-wide">
            {row.label}
            {row.aiExtracted ? <AIExtractedBadge /> : null}
          </dt>
          <dd className="mt-0.5 text-sm text-foreground/90 break-words">
            {formatValue(row.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

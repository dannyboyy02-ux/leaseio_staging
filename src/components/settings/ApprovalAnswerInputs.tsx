// ─────────────────────────────────────────────────────────────────────────
// The question half of the answer strip: "A ⟦Property⟧ lease in ⟦Warehouse⟧
// costing ⟦$200,000⟧ a year."
//
// The sentence words ARE the labels — every control carries a real
// <Label htmlFor>, so the strip reads as prose visually and as a labelled form
// to a screen reader. Ids are supplied by the caller (from useId) because two
// strips can be mounted at once.
//
// REGION AND LEASE TYPE ARE ABSENT ON PURPOSE (D-Q2): intake collects neither,
// so offering them would let an admin ask a question no real request can pose.
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { localizedAssetTypeLabel } from '@/lib/assetTypeLabels';
import type { AssetTypeOption } from '@/lib/assetTypes';
import type { HeroInputs } from '@/lib/approvalHeroSeed';

export interface ApprovalAnswerInputsProps {
  /** null until the opening sample has been seeded. */
  value: HeroInputs | null;
  onChange: (patch: Partial<HeroInputs>) => void;
  assetOptions: AssetTypeOption[];
  /** workspaces.department_options — suggestions, not a closed list. */
  departments: string[];
  /** Explains where the opening sample came from. Hidden once the user edits. */
  caption: string | null;
  ids: { asset: string; department: string; departmentList: string; amount: string };
}

export function ApprovalAnswerInputs({
  value,
  onChange,
  assetOptions,
  departments,
  caption,
  ids,
}: ApprovalAnswerInputsProps) {
  const { t, language } = useAppTranslation();

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={ids.asset} className="text-xs">
            {t('policy_editor.hero.label_asset', { defaultValue: 'Kind of lease' })}
          </Label>
          <Select
            value={value?.assetType || undefined}
            onValueChange={(v) => onChange({ assetType: v })}
          >
            <SelectTrigger id={ids.asset} className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assetOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {localizedAssetTypeLabel(o)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.department} className="text-xs">
            {t('policy_editor.hero.label_department', { defaultValue: 'Department' })}
          </Label>
          <Input
            id={ids.department}
            className="h-9"
            list={ids.departmentList}
            value={value?.department ?? ''}
            onChange={(e) => onChange({ department: e.target.value })}
            placeholder={t('policy_editor.hero.department_placeholder', {
              defaultValue: 'e.g. Warehouse',
            })}
          />
          {/* Free text with suggestions: the engine matches departments as
              exact strings, so a value that is not in the list is a legitimate
              question ("what would happen to a department I have not set up?"). */}
          <datalist id={ids.departmentList}>
            {departments.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.amount} className="text-xs">
            {t('policy_editor.hero.label_amount', { defaultValue: 'Cost per year' })}
          </Label>
          <AmountInput
            id={ids.amount}
            value={value?.annualCost ?? 0}
            language={language}
            onChange={(n) => onChange({ annualCost: n })}
            hint={t('policy_editor.hero.amount_hint', { defaultValue: 'US dollars per year' })}
          />
        </div>
      </div>
      {caption && <p className="text-xs text-muted-foreground">{caption}</p>}
    </div>
  );
}

/** Whole-dollar amount, thousands-grouped when not being edited. Parsing keeps
 *  digits only, so it round-trips in en and es alike regardless of which
 *  character that locale uses as a group separator. */
function AmountInput({
  id,
  value,
  language,
  onChange,
  hint,
}: {
  id: string;
  value: number;
  language: 'en' | 'es';
  onChange: (n: number) => void;
  hint: string;
}) {
  const group = (n: number) =>
    new Intl.NumberFormat(language === 'es' ? 'es-ES' : 'en-US').format(n);
  const [text, setText] = useState(() => group(value));
  const [editing, setEditing] = useState(false);

  // Re-render the grouped form when the value changes from OUTSIDE (the seed,
  // or a re-seed) — but never while the field has focus, which would fight the
  // user's caret mid-keystroke.
  useEffect(() => {
    if (!editing) setText(group(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editing, language]);

  return (
    <>
      <div className="relative">
        <span
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
          aria-hidden="true"
        >
          $
        </span>
        <Input
          id={id}
          className="h-9 pl-6"
          inputMode="decimal"
          aria-describedby={`${id}-hint`}
          value={text}
          onFocus={() => setEditing(true)}
          onChange={(e) => {
            setText(e.target.value);
            const digits = e.target.value.replace(/[^\d]/g, '');
            onChange(digits ? Number(digits) : 0);
          }}
          onBlur={() => {
            setEditing(false);
            setText(group(value));
          }}
        />
      </div>
      <p id={`${id}-hint`} className="sr-only">
        {hint}
      </p>
    </>
  );
}

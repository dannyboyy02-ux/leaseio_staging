import { useState, type ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { formatLocalizedCurrency, type SupportedLocale } from '@/lib/dateFormatters';
import { prettyAssetType, buildAssetTypeOptions, canonicalAssetType, type AssetTypeOption } from '@/lib/assetTypes';

// ───────────────────────────────────────────────────────────────────────────
// Constants — must stay aligned with leases.asset_type and leases.lease_type
// CHECK constraints. The "lease type" pill in the sentence is the visual
// home for BOTH match_asset_types and match_lease_types per the visual
// contract addendum (§3 — exactly four pills in the sentence template).
// ───────────────────────────────────────────────────────────────────────────

// Asset-type options are workspace-aware (built-ins + configured Asset Types),
// built via buildAssetTypeOptions in @/lib/assetTypes — the single source that
// replaced this file's former hardcoded list. Callers pass the resolved list in.
const DEFAULT_ASSET_TYPE_OPTIONS: AssetTypeOption[] = buildAssetTypeOptions();

const LEASE_TYPE_OPTIONS: string[] = ['Real Estate', 'Equipment'];

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface MatchCriteriaState {
  match_asset_types: string[];
  match_lease_types: string[];
  match_departments: string[];
  match_regions: string[];
  match_min_annual_cost: string;
  match_max_annual_cost: string;
}

type PillColor = 'blue' | 'emerald' | 'teal' | 'violet';

const PILL_FILLED: Record<PillColor, string> = {
  blue:
    'bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-900/50',
  emerald:
    'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/50',
  teal:
    'bg-teal-50 dark:bg-teal-900/30 text-teal-800 dark:text-teal-200 hover:bg-teal-100 dark:hover:bg-teal-900/50',
  violet:
    'bg-violet-50 dark:bg-violet-900/30 text-violet-800 dark:text-violet-200 hover:bg-violet-100 dark:hover:bg-violet-900/50',
};

const PILL_EMPTY =
  'border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-foreground hover:text-foreground';

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for vitest.
// ───────────────────────────────────────────────────────────────────────────

const fmtMoney = (raw: string, language: SupportedLocale): string => {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  return formatLocalizedCurrency(n, language);
};

export function joinWithOr(values: string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

/** "any lease type" when both arrays empty; otherwise asset+lease combined. */
export function leaseTypeLabel(
  state: MatchCriteriaState,
  options: AssetTypeOption[] = DEFAULT_ASSET_TYPE_OPTIONS,
): string {
  const assetLabels = state.match_asset_types.map(
    // prettyAssetType humanizes values outside the resolved option list —
    // workspace-configured or legacy keys (e.g. 'real_estate') rendered raw
    // snake_case in the rule sentence (live walkthrough 2026-07-12).
    (v) => options.find((o) => o.value === v)?.label ?? prettyAssetType(v),
  );
  const all = [...assetLabels, ...state.match_lease_types];
  if (all.length === 0) return 'any lease type';
  return joinWithOr(all);
}

export function departmentLabel(state: MatchCriteriaState): string {
  if (state.match_departments.length === 0) return 'any department';
  return joinWithOr(state.match_departments);
}

export function regionLabel(state: MatchCriteriaState): string {
  if (state.match_regions.length === 0) return 'any region';
  return joinWithOr(state.match_regions);
}

export function costLabel(state: MatchCriteriaState, language: SupportedLocale): string {
  const min = state.match_min_annual_cost.trim();
  const max = state.match_max_annual_cost.trim();
  if (!min && !max) return 'any annual cost';
  if (min && max) return `${fmtMoney(min, language)} – ${fmtMoney(max, language)}`;
  if (min) return `at least ${fmtMoney(min, language)}`;
  return `at most ${fmtMoney(max, language)}`;
}

export function isLeaseTypeActive(state: MatchCriteriaState): boolean {
  return state.match_asset_types.length > 0 || state.match_lease_types.length > 0;
}
export function isDepartmentActive(state: MatchCriteriaState): boolean {
  return state.match_departments.length > 0;
}
export function isRegionActive(state: MatchCriteriaState): boolean {
  return state.match_regions.length > 0;
}
export function isCostActive(state: MatchCriteriaState): boolean {
  return (
    state.match_min_annual_cost.trim() !== '' ||
    state.match_max_annual_cost.trim() !== ''
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Component — always renders the four-pill sentence per addendum §3.
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  state: MatchCriteriaState;
  onChange: (next: MatchCriteriaState) => void;
  departmentSuggestions: string[];
  regionSuggestions: string[];
  /** Workspace-resolved asset-type options (built-ins + configured Asset
   *  Types). Falls back to the built-ins when the caller doesn't pass them. */
  assetTypeOptions?: AssetTypeOption[];
}

export function MatchCriteriaSentence({
  state,
  onChange,
  departmentSuggestions,
  regionSuggestions,
  assetTypeOptions = DEFAULT_ASSET_TYPE_OPTIONS,
}: Props) {
  const { language } = useLanguage();
  return (
    <p className="text-sm leading-8 text-foreground">
      When someone requests{' '}
      <CriterionPill
        label={leaseTypeLabel(state, assetTypeOptions)}
        active={isLeaseTypeActive(state)}
        color="blue"
        onClear={() =>
          onChange({ ...state, match_asset_types: [], match_lease_types: [] })
        }
      >
        <LeaseTypeEditor state={state} onChange={onChange} assetTypeOptions={assetTypeOptions} />
      </CriterionPill>
      {' '}in{' '}
      <CriterionPill
        label={departmentLabel(state)}
        active={isDepartmentActive(state)}
        color="emerald"
        onClear={() => onChange({ ...state, match_departments: [] })}
      >
        <ChipEditor
          values={state.match_departments}
          onChange={(v) => onChange({ ...state, match_departments: v })}
          suggestions={departmentSuggestions}
          placeholder="Add a department…"
          heading="Match these departments"
        />
      </CriterionPill>
      {' '}for{' '}
      <CriterionPill
        label={costLabel(state, language)}
        active={isCostActive(state)}
        color="violet"
        onClear={() =>
          onChange({
            ...state,
            match_min_annual_cost: '',
            match_max_annual_cost: '',
          })
        }
      >
        <CostRangeEditor state={state} onChange={onChange} />
      </CriterionPill>
      , located in{' '}
      <CriterionPill
        label={regionLabel(state)}
        active={isRegionActive(state)}
        color="teal"
        onClear={() => onChange({ ...state, match_regions: [] })}
      >
        <ChipEditor
          values={state.match_regions}
          onChange={(v) => onChange({ ...state, match_regions: v })}
          suggestions={regionSuggestions}
          placeholder="Add a region…"
          heading="Match these regions"
        />
      </CriterionPill>
      .
    </p>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CriterionPill — one editable pill in the sentence. The × button appears
// on hover (only when the pill is filled) and clears the criterion.
// ───────────────────────────────────────────────────────────────────────────

interface CriterionPillProps {
  label: string;
  active: boolean;
  color: PillColor;
  onClear: () => void;
  children: ReactNode;
}

function CriterionPill({
  label,
  active,
  color,
  onClear,
  children,
}: CriterionPillProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className="inline-flex items-center align-baseline group relative">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-sm font-medium transition-colors',
              active ? PILL_FILLED[color] : PILL_EMPTY,
            )}
          >
            <span>{label}</span>
            <ChevronDown className="w-3 h-3 opacity-70" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3 max-h-80 overflow-y-auto">
          {children}
        </PopoverContent>
      </Popover>
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          aria-label="Remove this filter"
          className="ml-1 inline-flex items-center justify-center rounded-full opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Editors — popover content per pill.
// ───────────────────────────────────────────────────────────────────────────

function LeaseTypeEditor({
  state,
  onChange,
  assetTypeOptions,
}: {
  state: MatchCriteriaState;
  onChange: (s: MatchCriteriaState) => void;
  assetTypeOptions: AssetTypeOption[];
}) {
  // Compare/toggle by canonical key so a rule stored with a legacy or
  // AI-classifier spelling ('real_estate') shows the matching built-in
  // ('property') checked — and clicking it removes that stored value rather
  // than appending a second synonym. Mirrors the matcher's canonical equality.
  const assetChecked = (optionValue: string) =>
    state.match_asset_types.some((x) => canonicalAssetType(x) === canonicalAssetType(optionValue));
  const toggleAsset = (v: string) => {
    const canon = canonicalAssetType(v);
    const next = assetChecked(v)
      ? state.match_asset_types.filter((x) => canonicalAssetType(x) !== canon)
      : [...state.match_asset_types, v];
    onChange({ ...state, match_asset_types: next });
  };
  const toggleLease = (v: string) => {
    const next = state.match_lease_types.includes(v)
      ? state.match_lease_types.filter((x) => x !== v)
      : [...state.match_lease_types, v];
    onChange({ ...state, match_lease_types: next });
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Asset types</p>
        {assetTypeOptions.map((o) => (
          <label
            key={o.value}
            className="flex items-center gap-2 py-0.5 cursor-pointer text-sm"
          >
            <Checkbox
              checked={assetChecked(o.value)}
              onCheckedChange={() => toggleAsset(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Lease types</p>
        {LEASE_TYPE_OPTIONS.map((o) => (
          <label
            key={o}
            className="flex items-center gap-2 py-0.5 cursor-pointer text-sm"
          >
            <Checkbox
              checked={state.match_lease_types.includes(o)}
              onCheckedChange={() => toggleLease(o)}
            />
            <span>{o}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function CostRangeEditor({
  state,
  onChange,
}: {
  state: MatchCriteriaState;
  onChange: (s: MatchCriteriaState) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Set the dollar range</p>
      <p className="text-[10px] text-muted-foreground">
        Leave one side blank to mean "any".
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide">From (USD)</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={state.match_min_annual_cost}
            onChange={(e) =>
              onChange({ ...state, match_min_annual_cost: e.target.value })
            }
            placeholder="Any"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide">To (USD)</Label>
          <Input
            type="number"
            inputMode="decimal"
            value={state.match_max_annual_cost}
            onChange={(e) =>
              onChange({ ...state, match_max_annual_cost: e.target.value })
            }
            placeholder="Any"
            className="h-8 text-sm"
          />
        </div>
      </div>
    </div>
  );
}

interface ChipEditorProps {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
  heading: string;
}

function ChipEditor({
  values,
  onChange,
  suggestions,
  placeholder,
  heading,
}: ChipEditorProps) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const trimmed = v.trim();
    if (!trimmed || values.includes(trimmed)) return;
    onChange([...values, trimmed]);
    setDraft('');
  };
  const remove = (v: string) => onChange(values.filter((x) => x !== v));
  const remaining = suggestions.filter((s) => !values.includes(s));

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{heading}</p>
      <div className="flex flex-wrap gap-1.5 min-h-[24px]">
        {values.map((v) => (
          <Badge key={v} variant="secondary" className="text-xs gap-1">
            {v}
            <button
              type="button"
              onClick={() => remove(v)}
              className="hover:text-destructive"
            >
              <X size={10} />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder={placeholder}
          className="h-8 text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add(draft)}
          disabled={!draft.trim()}
        >
          Add
        </Button>
      </div>
      {remaining.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[10px] text-muted-foreground self-center">
            Suggestions:
          </span>
          {remaining.slice(0, 8).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="text-[10px] px-1.5 py-0.5 rounded border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

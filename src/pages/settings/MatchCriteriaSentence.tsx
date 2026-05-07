import { useEffect, useState } from 'react';
import { Plus, X, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// ───────────────────────────────────────────────────────────────────────────
// Constants — must stay aligned with leases.asset_type and leases.lease_type
// CHECK constraints. (Duplicated from ApprovalPolicyEditPage / TestDialog by
// design; the wire format reads these raw enum values, so they're the load-
// bearing surface that has to match the DB. Per docs/APPROVAL_POLICY_EDITOR_
// REDESIGN.md "What does NOT change".)
// ───────────────────────────────────────────────────────────────────────────

const ASSET_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'property', label: 'Property (Real Estate)' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'other', label: 'Other' },
];

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

type FilterKind =
  | 'asset_types'
  | 'lease_types'
  | 'departments'
  | 'regions'
  | 'cost_range';

const ALL_KINDS: FilterKind[] = [
  'asset_types',
  'lease_types',
  'departments',
  'regions',
  'cost_range',
];

const ADD_LABEL: Record<FilterKind, string> = {
  asset_types: 'Asset type',
  lease_types: 'Lease type',
  departments: 'Department',
  regions: 'Region',
  cost_range: 'Annual cost',
};

const REMOVE_ARIA: Record<FilterKind, string> = {
  asset_types: 'Remove asset type filter',
  lease_types: 'Remove lease type filter',
  departments: 'Remove department filter',
  regions: 'Remove region filter',
  cost_range: 'Remove annual cost filter',
};

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

function isActive(state: MatchCriteriaState, kind: FilterKind): boolean {
  switch (kind) {
    case 'asset_types':
      return state.match_asset_types.length > 0;
    case 'lease_types':
      return state.match_lease_types.length > 0;
    case 'departments':
      return state.match_departments.length > 0;
    case 'regions':
      return state.match_regions.length > 0;
    case 'cost_range':
      return (
        state.match_min_annual_cost.trim() !== '' ||
        state.match_max_annual_cost.trim() !== ''
      );
  }
}

const fmtMoney = (raw: string): string => {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
};

// "A" → "A", "A, B" → "A or B", "A, B, C" → "A, B, or C"
function joinWithOr(values: string[]): string {
  if (values.length === 0) return '…';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

function pillLabel(state: MatchCriteriaState, kind: FilterKind): string {
  switch (kind) {
    case 'asset_types': {
      const labels = state.match_asset_types.map(
        (v) => ASSET_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v,
      );
      return labels.length === 0
        ? 'asset type is …'
        : `asset type is ${joinWithOr(labels)}`;
    }
    case 'lease_types':
      return state.match_lease_types.length === 0
        ? 'lease type is …'
        : `lease type is ${joinWithOr(state.match_lease_types)}`;
    case 'departments':
      return state.match_departments.length === 0
        ? 'department is …'
        : `department is ${joinWithOr(state.match_departments)}`;
    case 'regions':
      return state.match_regions.length === 0
        ? 'region is …'
        : `region is ${joinWithOr(state.match_regions)}`;
    case 'cost_range': {
      const min = state.match_min_annual_cost.trim();
      const max = state.match_max_annual_cost.trim();
      if (min && max) return `annual cost is between ${fmtMoney(min)} and ${fmtMoney(max)}`;
      if (min) return `annual cost is at least ${fmtMoney(min)}`;
      if (max) return `annual cost is at most ${fmtMoney(max)}`;
      return 'annual cost is …';
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Component
// ───────────────────────────────────────────────────────────────────────────

interface Props {
  state: MatchCriteriaState;
  onChange: (next: MatchCriteriaState) => void;
  departmentSuggestions: string[];
  regionSuggestions: string[];
}

export function MatchCriteriaSentence({
  state,
  onChange,
  departmentSuggestions,
  regionSuggestions,
}: Props) {
  // pendingKind = the filter the user just chose from "Add filter". The pill
  // for that kind renders even though state hasn't been populated yet, and
  // its popover auto-opens. We clear pendingKind on the next tick so a
  // remove-and-re-add of the same kind triggers a fresh state change.
  const [pendingKind, setPendingKind] = useState<FilterKind | null>(null);

  useEffect(() => {
    if (pendingKind === null) return;
    const id = setTimeout(() => setPendingKind(null), 30);
    return () => clearTimeout(id);
  }, [pendingKind]);

  const activeKinds = ALL_KINDS.filter((k) => isActive(state, k));
  const visibleKinds: FilterKind[] =
    pendingKind && !activeKinds.includes(pendingKind)
      ? [...activeKinds, pendingKind]
      : activeKinds;
  const inactiveKinds = ALL_KINDS.filter((k) => !visibleKinds.includes(k));

  const removeFilter = (kind: FilterKind) => {
    switch (kind) {
      case 'asset_types':
        onChange({ ...state, match_asset_types: [] });
        break;
      case 'lease_types':
        onChange({ ...state, match_lease_types: [] });
        break;
      case 'departments':
        onChange({ ...state, match_departments: [] });
        break;
      case 'regions':
        onChange({ ...state, match_regions: [] });
        break;
      case 'cost_range':
        onChange({
          ...state,
          match_min_annual_cost: '',
          match_max_annual_cost: '',
        });
        break;
    }
    if (pendingKind === kind) setPendingKind(null);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-8">
        This rule applies{' '}
        {visibleKinds.length === 0 ? (
          <span className="font-medium text-foreground">to all requests</span>
        ) : (
          <>
            <span>when </span>
            {visibleKinds.map((k, i) => (
              <span key={k}>
                {i > 0 && <span className="text-muted-foreground"> and </span>}
                <FilterPill
                  kind={k}
                  state={state}
                  onChange={onChange}
                  onRemove={() => removeFilter(k)}
                  departmentSuggestions={departmentSuggestions}
                  regionSuggestions={regionSuggestions}
                  autoOpen={pendingKind === k}
                />
              </span>
            ))}
          </>
        )}
        .
      </p>

      {inactiveKinds.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add filter
              <ChevronDown className="h-3.5 w-3.5 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {inactiveKinds.map((k) => (
              <DropdownMenuItem
                key={k}
                onSelect={() => setPendingKind(k)}
              >
                {ADD_LABEL[k]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// FilterPill — one pill in the sentence
// ───────────────────────────────────────────────────────────────────────────

interface FilterPillProps {
  kind: FilterKind;
  state: MatchCriteriaState;
  onChange: (next: MatchCriteriaState) => void;
  onRemove: () => void;
  departmentSuggestions: string[];
  regionSuggestions: string[];
  autoOpen: boolean;
}

function FilterPill({
  kind,
  state,
  onChange,
  onRemove,
  departmentSuggestions,
  regionSuggestions,
  autoOpen,
}: FilterPillProps) {
  const active = isActive(state, kind);
  const label = pillLabel(state, kind);

  // If the user opened a fresh pill via "Add filter" and then closed it
  // without picking any value, snap the empty pill out of the sentence.
  const handleOpenChange = (open: boolean) => {
    if (!open && !active) onRemove();
  };

  return (
    <Popover defaultOpen={autoOpen} onOpenChange={handleOpenChange}>
      <span className="inline-flex items-center align-baseline">
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center rounded-md px-2 py-0.5 text-sm font-medium transition-colors',
              'border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
              !active && 'border-dashed text-primary/70 italic',
            )}
          >
            {label}
          </button>
        </PopoverTrigger>
        <button
          type="button"
          onClick={onRemove}
          aria-label={REMOVE_ARIA[kind]}
          className="ml-0.5 inline-flex items-center justify-center rounded p-0.5 text-primary/70 hover:bg-destructive/10 hover:text-destructive"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
      <PopoverContent align="start" className="w-72">
        <PillEditor
          kind={kind}
          state={state}
          onChange={onChange}
          departmentSuggestions={departmentSuggestions}
          regionSuggestions={regionSuggestions}
        />
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PillEditor — popover content per filter kind
// ───────────────────────────────────────────────────────────────────────────

interface PillEditorProps {
  kind: FilterKind;
  state: MatchCriteriaState;
  onChange: (next: MatchCriteriaState) => void;
  departmentSuggestions: string[];
  regionSuggestions: string[];
}

function PillEditor({
  kind,
  state,
  onChange,
  departmentSuggestions,
  regionSuggestions,
}: PillEditorProps) {
  if (kind === 'asset_types') {
    const values = state.match_asset_types;
    const toggle = (v: string) => {
      const next = values.includes(v)
        ? values.filter((x) => x !== v)
        : [...values, v];
      onChange({ ...state, match_asset_types: next });
    };
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium">Match these asset types</p>
        {ASSET_TYPE_OPTIONS.map((o) => (
          <label
            key={o.value}
            className="flex items-center gap-2 py-1 cursor-pointer text-sm"
          >
            <Checkbox
              checked={values.includes(o.value)}
              onCheckedChange={() => toggle(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  }

  if (kind === 'lease_types') {
    const values = state.match_lease_types;
    const toggle = (v: string) => {
      const next = values.includes(v)
        ? values.filter((x) => x !== v)
        : [...values, v];
      onChange({ ...state, match_lease_types: next });
    };
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium">Match these lease types</p>
        {LEASE_TYPE_OPTIONS.map((o) => (
          <label
            key={o}
            className="flex items-center gap-2 py-1 cursor-pointer text-sm"
          >
            <Checkbox
              checked={values.includes(o)}
              onCheckedChange={() => toggle(o)}
            />
            <span>{o}</span>
          </label>
        ))}
      </div>
    );
  }

  if (kind === 'departments') {
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium">Match these departments</p>
        <ChipPicker
          values={state.match_departments}
          onChange={(v) => onChange({ ...state, match_departments: v })}
          suggestions={departmentSuggestions}
          placeholder="Add a department…"
        />
      </div>
    );
  }

  if (kind === 'regions') {
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium">Match these regions</p>
        <ChipPicker
          values={state.match_regions}
          onChange={(v) => onChange({ ...state, match_regions: v })}
          suggestions={regionSuggestions}
          placeholder="Add a region…"
        />
      </div>
    );
  }

  // cost_range
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Match this dollar range</p>
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

// ───────────────────────────────────────────────────────────────────────────
// ChipPicker — shared between department & region popovers. Inlined here
// rather than re-exported from ApprovalPolicyEditPage because the old caller
// of the equivalent helper there is going away with this phase.
// ───────────────────────────────────────────────────────────────────────────

interface ChipPickerProps {
  values: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  placeholder: string;
}

function ChipPicker({
  values,
  onChange,
  suggestions,
  placeholder,
}: ChipPickerProps) {
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

import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Plus,
  Trash2,
  GripVertical,
  Check,
  X,
  ChevronDown,
  UserCircle2,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

// ───────────────────────────────────────────────────────────────────────────
// Constants — must stay aligned with workspace_roles. Mirrored from the
// equivalent in ApprovalPolicyEditPage; the page's chain editor used to read
// this list from there directly. Kept colocated with the diagram component
// to make the chain-rendering surface self-contained.
// ───────────────────────────────────────────────────────────────────────────

export const FUNCTIONAL_ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'submitter', label: 'Submitter' },
  { value: 'manager_approver', label: 'Manager approver' },
  { value: 'financial_approver', label: 'Financial approver' },
  { value: 'signator', label: 'Signator' },
  { value: 'admin', label: 'Admin' },
];

// ───────────────────────────────────────────────────────────────────────────
// Types — public, mirror the ChainStep shape carried by the parent page so
// the wire format stays byte-identical.
// ───────────────────────────────────────────────────────────────────────────

export interface ChainStep {
  uiId: string;
  step_order: number;
  parallel_group: number;
  approver_user_id: string | null;
  approver_role: string | null;
  delegate_user_id: string | null;
  delegate_after_days: number | null;
  is_required: boolean;
}

export interface MemberOption {
  id: string;
  label: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for vitest. groupByParallel / addNextStep /
// addParallelApprover / reorderGroups all return new arrays; never mutate.
// ───────────────────────────────────────────────────────────────────────────

const newUiId = () =>
  `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Group steps by parallel_group, ordered by their first step's step_order.
 * Within a group, sort by step_order.
 */
export function groupByParallel(steps: ChainStep[]): ChainStep[][] {
  const buckets = new Map<number, ChainStep[]>();
  for (const s of steps) {
    if (!buckets.has(s.parallel_group)) buckets.set(s.parallel_group, []);
    buckets.get(s.parallel_group)!.push(s);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => a.step_order - b.step_order);
  }
  return Array.from(buckets.values()).sort(
    (a, b) => a[0].step_order - b[0].step_order,
  );
}

/**
 * Append a fresh sequential step (a new parallel group). Used by the
 * "+ Add the next step" button at the bottom of the diagram.
 */
export function addNextStep(steps: ChainStep[]): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  const maxGroup = steps.reduce((m, s) => Math.max(m, s.parallel_group), 0);
  return [
    ...steps,
    {
      uiId: newUiId(),
      step_order: maxOrder + 1,
      parallel_group: maxGroup + 1,
      approver_user_id: null,
      approver_role: 'manager_approver',
      delegate_user_id: null,
      delegate_after_days: null,
      is_required: true,
    },
  ];
}

/**
 * Append a parallel approver to an existing group. Used by the
 * "+ Add another approver to this step" button inside a row.
 */
export function addParallelApprover(
  steps: ChainStep[],
  parallelGroup: number,
): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  return [
    ...steps,
    {
      uiId: newUiId(),
      step_order: maxOrder + 1,
      parallel_group: parallelGroup,
      approver_user_id: null,
      approver_role: 'manager_approver',
      delegate_user_id: null,
      delegate_after_days: null,
      is_required: true,
    },
  ];
}

/**
 * Reorder the parallel groups (rows) and rewrite step_order so it matches
 * the new visual order. Within each group, internal step_order is preserved
 * relative to the group; only the *across-group* sequence changes.
 */
export function reorderGroups(
  steps: ChainStep[],
  fromIndex: number,
  toIndex: number,
): ChainStep[] {
  const groups = groupByParallel(steps);
  const reordered = arrayMove(groups, fromIndex, toIndex);
  let nextOrder = 1;
  const out: ChainStep[] = [];
  for (const group of reordered) {
    for (const s of group) {
      out.push({ ...s, step_order: nextOrder++ });
    }
  }
  return out;
}

/**
 * Remove one step by uiId. If that was the only step in its group, the
 * group goes away too (groupByParallel just stops bucketing it).
 */
export function removeStep(steps: ChainStep[], uiId: string): ChainStep[] {
  return steps.filter((s) => s.uiId !== uiId);
}

/**
 * Patch one step by uiId, returning a new array.
 */
export function updateStep(
  steps: ChainStep[],
  uiId: string,
  patch: Partial<ChainStep>,
): ChainStep[] {
  return steps.map((s) => (s.uiId === uiId ? { ...s, ...patch } : s));
}

// ───────────────────────────────────────────────────────────────────────────
// ChainDiagram — replaces the old ChainEditor. Vertical step diagram, drag
// handles per row, "Add another approver to this step" within rows, "Add
// the next step" between, guided empty state, mobile-stacked parallel
// approvers with explicit "AND at the same time" labels.
// ───────────────────────────────────────────────────────────────────────────

interface ChainDiagramProps {
  title: string;
  description: string;
  steps: ChainStep[];
  setSteps: (s: ChainStep[]) => void;
  memberOptions: MemberOption[];
}

export function ChainDiagram({
  title,
  description,
  steps,
  setSteps,
  memberOptions,
}: ChainDiagramProps) {
  const groups = groupByParallel(steps);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = groups.findIndex((g) => String(g[0].parallel_group) === active.id);
    const toIndex = groups.findIndex((g) => String(g[0].parallel_group) === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    setSteps(reorderGroups(steps, fromIndex, toIndex));
  };

  const groupIds = groups.map((g) => String(g[0].parallel_group));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-10 text-center">
            <UserCircle2 className="h-8 w-8 text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground mb-3">
              No approvers yet for this step.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSteps(addNextStep(steps))}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              Add the first approver
            </Button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-3">
                {groups.map((group, idx) => (
                  <div key={group[0].parallel_group}>
                    <ParallelStepRow
                      stepNumber={idx + 1}
                      group={group}
                      memberOptions={memberOptions}
                      onUpdate={(uiId, patch) => setSteps(updateStep(steps, uiId, patch))}
                      onRemove={(uiId) => setSteps(removeStep(steps, uiId))}
                      onAddParallel={() =>
                        setSteps(addParallelApprover(steps, group[0].parallel_group))
                      }
                    />
                    {idx < groups.length - 1 && (
                      <div className="flex justify-center my-2">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          then ↓
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {groups.length > 0 && (
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setSteps(addNextStep(steps))}
            >
              <Plus className="h-4 w-4 mr-1.5" />
              Add the next step
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ParallelStepRow — one row holding 1+ ApproverCards. Drag handle reorders
// the row in the chain. Inside, cards arrange side-by-side (md+) or
// stacked (sm) with explicit "AND at the same time" labels between.
// ───────────────────────────────────────────────────────────────────────────

interface ParallelStepRowProps {
  stepNumber: number;
  group: ChainStep[];
  memberOptions: MemberOption[];
  onUpdate: (uiId: string, patch: Partial<ChainStep>) => void;
  onRemove: (uiId: string) => void;
  onAddParallel: () => void;
}

export function ParallelStepRow({
  stepNumber,
  group,
  memberOptions,
  onUpdate,
  onRemove,
  onAddParallel,
}: ParallelStepRowProps) {
  const id = String(group[0].parallel_group);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'rounded-md border bg-card',
        isDragging && 'ring-2 ring-primary',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30 rounded-t-md">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
            aria-label={`Drag to reorder step ${stepNumber}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Step {stepNumber}
          </p>
          {group.length > 1 && (
            <span className="text-[10px] text-muted-foreground">
              · {group.length} approvers in parallel
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onAddParallel}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add another approver to this step
        </Button>
      </div>

      <div className="p-3 space-y-3 md:space-y-0 md:flex md:items-stretch md:gap-3">
        {group.map((step, idx) => (
          <div key={step.uiId} className="md:flex-1 flex flex-col gap-3 md:gap-0">
            <ApproverCard
              step={step}
              memberOptions={memberOptions}
              canRemove={true}
              onUpdate={(patch) => onUpdate(step.uiId, patch)}
              onRemove={() => onRemove(step.uiId)}
            />
            {idx < group.length - 1 && (
              <div className="flex items-center justify-center md:hidden">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground py-1">
                  AND at the same time
                </span>
              </div>
            )}
          </div>
        )).flatMap((node, idx) =>
          idx < group.length - 1
            ? [
                node,
                <div
                  key={`sep-${group[idx].uiId}`}
                  className="hidden md:flex items-center"
                >
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground whitespace-nowrap px-1">
                    AND at the same time
                  </span>
                </div>,
              ]
            : [node],
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ApproverCard — the unit. Approver picker (typeahead Command), required
// toggle, backup approver picker, backup-after-N-days input, remove button.
// ───────────────────────────────────────────────────────────────────────────

interface ApproverCardProps {
  step: ChainStep;
  memberOptions: MemberOption[];
  canRemove: boolean;
  onUpdate: (patch: Partial<ChainStep>) => void;
  onRemove: () => void;
}

export function ApproverCard({
  step,
  memberOptions,
  canRemove,
  onUpdate,
  onRemove,
}: ApproverCardProps) {
  const approverDisplay = approverDisplayLabel(step, memberOptions);
  const backupDisplay = backupDisplayLabel(step, memberOptions);

  return (
    <div className="rounded-md border bg-background p-3 space-y-3 flex-1">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0 space-y-1">
          <Label className="text-[10px] uppercase tracking-wide">Who approves?</Label>
          <ApproverPicker
            currentLabel={approverDisplay}
            currentKind={step.approver_role ? 'role' : step.approver_user_id ? 'user' : 'none'}
            memberOptions={memberOptions}
            includeRoles={true}
            onSelectRole={(role) =>
              onUpdate({ approver_role: role, approver_user_id: null })
            }
            onSelectUser={(userId) =>
              onUpdate({ approver_user_id: userId, approver_role: null })
            }
          />
        </div>
        {canRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
            onClick={onRemove}
            title="Remove approver"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide">
          Backup approver (optional)
        </Label>
        <ApproverPicker
          currentLabel={backupDisplay}
          currentKind={step.delegate_user_id ? 'user' : 'none'}
          memberOptions={memberOptions}
          includeRoles={false}
          allowClear={!!step.delegate_user_id}
          onSelectUser={(userId) => onUpdate({ delegate_user_id: userId })}
          onClear={() =>
            onUpdate({ delegate_user_id: null, delegate_after_days: null })
          }
        />
      </div>

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide">
          Backup approver if no answer in N days
        </Label>
        <Input
          type="number"
          min={1}
          value={step.delegate_after_days ?? ''}
          onChange={(e) =>
            onUpdate({
              delegate_after_days:
                e.target.value === '' ? null : parseInt(e.target.value, 10),
            })
          }
          placeholder="—"
          className="h-8 text-sm"
          disabled={!step.delegate_user_id}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch
          checked={step.is_required}
          onCheckedChange={(v) => onUpdate({ is_required: v })}
          id={`req-${step.uiId}`}
        />
        <Label htmlFor={`req-${step.uiId}`} className="text-xs font-normal cursor-pointer">
          {step.is_required ? 'Required' : 'Optional'}
        </Label>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ApproverPicker — typeahead Command palette. Roles + People grouped, or
// People only when used for the backup-approver field.
// ───────────────────────────────────────────────────────────────────────────

interface ApproverPickerProps {
  currentLabel: string;
  currentKind: 'role' | 'user' | 'none';
  memberOptions: MemberOption[];
  includeRoles: boolean;
  allowClear?: boolean;
  onSelectRole?: (role: string) => void;
  onSelectUser?: (userId: string) => void;
  onClear?: () => void;
}

function ApproverPicker({
  currentLabel,
  currentKind,
  memberOptions,
  includeRoles,
  allowClear,
  onSelectRole,
  onSelectUser,
  onClear,
}: ApproverPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between font-normal text-sm"
        >
          <span className={cn('truncate', currentKind === 'none' && 'text-muted-foreground')}>
            {currentLabel}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50 ml-1" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput
            placeholder={includeRoles ? 'Search roles or people…' : 'Search people…'}
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>

            {includeRoles && (
              <CommandGroup heading="Anyone with a role">
                {FUNCTIONAL_ROLE_OPTIONS.map((r) => (
                  <CommandItem
                    key={`role-${r.value}`}
                    value={`role ${r.label}`}
                    onSelect={() => {
                      onSelectRole?.(r.value);
                      setOpen(false);
                    }}
                  >
                    <Users className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    <span className="flex-1">{r.label}</span>
                    {currentKind === 'role' &&
                      currentLabel.toLowerCase() === r.label.toLowerCase() && (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {includeRoles && memberOptions.length > 0 && <CommandSeparator />}

            <CommandGroup heading="A specific person">
              {memberOptions.length === 0 ? (
                <CommandItem disabled value="__none__">
                  <span className="text-muted-foreground text-xs">
                    No workspace members loaded
                  </span>
                </CommandItem>
              ) : (
                memberOptions.map((m) => (
                  <CommandItem
                    key={`user-${m.id}`}
                    value={`user ${m.label}`}
                    onSelect={() => {
                      onSelectUser?.(m.id);
                      setOpen(false);
                    }}
                  >
                    <UserCircle2 className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    <span className="flex-1 truncate">{m.label}</span>
                    {currentKind === 'user' && currentLabel === m.label && (
                      <Check className="h-3.5 w-3.5 text-primary shrink-0 ml-1" />
                    )}
                  </CommandItem>
                ))
              )}
            </CommandGroup>

            {allowClear && currentKind !== 'none' && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    onSelect={() => {
                      onClear?.();
                      setOpen(false);
                    }}
                  >
                    <X className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                    <span className="text-muted-foreground">Clear selection</span>
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Display-label helpers — pulled out so ApproverCard stays compact and the
// label format is testable.
// ───────────────────────────────────────────────────────────────────────────

export function approverDisplayLabel(
  step: ChainStep,
  memberOptions: MemberOption[],
): string {
  if (step.approver_role) {
    return (
      FUNCTIONAL_ROLE_OPTIONS.find((r) => r.value === step.approver_role)?.label ??
      step.approver_role
    );
  }
  if (step.approver_user_id) {
    return (
      memberOptions.find((m) => m.id === step.approver_user_id)?.label ??
      'Unknown person'
    );
  }
  return 'Pick an approver…';
}

export function backupDisplayLabel(
  step: ChainStep,
  memberOptions: MemberOption[],
): string {
  if (step.delegate_user_id) {
    return (
      memberOptions.find((m) => m.id === step.delegate_user_id)?.label ??
      'Unknown person'
    );
  }
  return 'No backup';
}

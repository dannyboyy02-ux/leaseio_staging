import { Fragment, useState } from 'react';
import { t } from 'i18next';
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
  Check,
  X,
  GripVertical,
  UserPlus,
  MoreVertical,
  Users,
  UserCircle2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useAppTranslation } from '@/hooks/useAppTranslation';

// ───────────────────────────────────────────────────────────────────────────
// Constants — keep aligned with workspace_roles. `abbrev` is the 2-letter
// avatar label per visual contract addendum §1.
// ───────────────────────────────────────────────────────────────────────────

export const FUNCTIONAL_ROLE_OPTIONS: Array<{
  value: string;
  labelKey: string;
  abbrev: string;
}> = [
  { value: 'submitter', labelKey: 'policy_editor.chain.role_submitter', abbrev: 'SU' },
  { value: 'manager_approver', labelKey: 'policy_editor.chain.role_manager_approver', abbrev: 'MA' },
  { value: 'financial_approver', labelKey: 'policy_editor.chain.role_financial_approver', abbrev: 'FA' },
  { value: 'signator', labelKey: 'policy_editor.chain.role_signator', abbrev: 'SG' },
  { value: 'admin', labelKey: 'policy_editor.chain.role_admin', abbrev: 'AD' },
];

// ───────────────────────────────────────────────────────────────────────────
// Types
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

export interface StepCaption {
  badge: string;
  primary: string;
  secondary: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for vitest.
// ───────────────────────────────────────────────────────────────────────────

const newUiId = () =>
  `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Produce a fresh empty step. Per the visual contract addendum §4, seeded
 * empty rules carry one of these per stage; the slot renders as the dashed
 * "Choose an approver…" CTA. approver_role + approver_user_id both null
 * is the canonical "empty" state — validation rejects it on save, which
 * forces the admin to pick an approver before the rule goes live.
 */
export function blankStep(stepOrder: number, parallelGroup: number): ChainStep {
  return {
    uiId: newUiId(),
    step_order: stepOrder,
    parallel_group: parallelGroup,
    approver_user_id: null,
    approver_role: null,
    delegate_user_id: null,
    delegate_after_days: null,
    is_required: true,
  };
}

export function seedSingleEmptyStep(): ChainStep[] {
  return [blankStep(1, 1)];
}

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

export function addNextStep(steps: ChainStep[]): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  const maxGroup = steps.reduce((m, s) => Math.max(m, s.parallel_group), 0);
  return [...steps, blankStep(maxOrder + 1, maxGroup + 1)];
}

export function addParallelApprover(
  steps: ChainStep[],
  parallelGroup: number,
): ChainStep[] {
  const maxOrder = steps.reduce((m, s) => Math.max(m, s.step_order), 0);
  return [...steps, blankStep(maxOrder + 1, parallelGroup)];
}

export function reorderGroups(
  steps: ChainStep[],
  fromIndex: number,
  toIndex: number,
): ChainStep[] {
  const groups = groupByParallel(steps);
  const reordered = arrayMove(groups, fromIndex, toIndex);
  let nextOrder = 1;
  const out: ChainStep[] = [];
  for (const g of reordered) {
    for (const s of g) {
      out.push({ ...s, step_order: nextOrder++ });
    }
  }
  return out;
}

export function removeStep(steps: ChainStep[], uiId: string): ChainStep[] {
  return steps.filter((s) => s.uiId !== uiId);
}

export function updateStep(
  steps: ChainStep[],
  uiId: string,
  patch: Partial<ChainStep>,
): ChainStep[] {
  return steps.map((s) => (s.uiId === uiId ? { ...s, ...patch } : s));
}

// ───────────────────────────────────────────────────────────────────────────
// Avatar helpers — deterministic color per identifier (visual contract §1).
// ───────────────────────────────────────────────────────────────────────────

export const AVATAR_COLORS: Array<{ bg: string; text: string }> = [
  {
    bg: 'bg-blue-100 dark:bg-blue-900/40',
    text: 'text-blue-800 dark:text-blue-200',
  },
  {
    bg: 'bg-emerald-100 dark:bg-emerald-900/40',
    text: 'text-emerald-800 dark:text-emerald-200',
  },
  {
    bg: 'bg-pink-100 dark:bg-pink-900/40',
    text: 'text-pink-800 dark:text-pink-200',
  },
  {
    bg: 'bg-amber-100 dark:bg-amber-900/40',
    text: 'text-amber-800 dark:text-amber-200',
  },
  {
    bg: 'bg-violet-100 dark:bg-violet-900/40',
    text: 'text-violet-800 dark:text-violet-200',
  },
  {
    bg: 'bg-teal-100 dark:bg-teal-900/40',
    text: 'text-teal-800 dark:text-teal-200',
  },
];

/** djb2 hash mod 6. Stable across reloads — same id always picks same color. */
export function avatarColorIndex(identifier: string): number {
  let hash = 5381;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash << 5) + hash + identifier.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash % AVATAR_COLORS.length;
}

/** Two-letter initials from a person's display name. Falls back gracefully. */
export function personInitials(label: string): string {
  // Strip any trailing "(...)" tail so "Alice Smith (a@x.com)" reads as initials AS.
  const noTail = label.replace(/\s*\([^)]+\)\s*$/, '');
  const parts = noTail.trim().match(/^([A-Za-z])\w*\s+([A-Za-z])\w*/);
  if (parts) return (parts[1] + parts[2]).toUpperCase();
  // Fallback: first two alphanumerics of whatever's there.
  const cleaned = noTail.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned.slice(0, 2).toUpperCase() || '??';
}

interface ApproverDisplay {
  initials: string;
  colorIndex: number;
  primary: string;
  secondary: string;
  empty: boolean;
}

export function approverDisplayFor(
  step: ChainStep,
  members: MemberOption[],
): ApproverDisplay {
  if (step.approver_role) {
    const role = FUNCTIONAL_ROLE_OPTIONS.find(
      (r) => r.value === step.approver_role,
    );
    return {
      initials: role?.abbrev ?? step.approver_role.slice(0, 2).toUpperCase(),
      colorIndex: avatarColorIndex(`role:${step.approver_role}`),
      primary: t('policy_editor.chain.anyone_with_role'),
      secondary: role ? t(role.labelKey) : step.approver_role,
      empty: false,
    };
  }
  if (step.approver_user_id) {
    const m = members.find((mm) => mm.id === step.approver_user_id);
    const fullLabel = m?.label ?? t('policy_editor.chain.unknown_person');
    const noTail = fullLabel.replace(/\s*\([^)]+\)\s*$/, '');
    const tail = fullLabel.match(/\(([^)]+)\)\s*$/)?.[1] ?? '';
    return {
      initials: personInitials(fullLabel),
      colorIndex: avatarColorIndex(`user:${step.approver_user_id}`),
      primary: noTail || fullLabel,
      secondary: tail,
      empty: false,
    };
  }
  return {
    initials: '?',
    colorIndex: 0,
    primary: '',
    secondary: '',
    empty: true,
  };
}

/** Format the inline secondary line: role/title, backup, optional flag. */
export function formatSecondaryLine(
  step: ChainStep,
  members: MemberOption[],
  baseSecondary: string,
): string {
  const parts: string[] = [];
  if (baseSecondary) parts.push(baseSecondary);
  if (step.delegate_user_id) {
    const backup = members.find((m) => m.id === step.delegate_user_id);
    const backupName =
      backup?.label.replace(/\s*\([^)]+\)\s*$/, '') ?? t('policy_editor.chain.unknown');
    const days = step.delegate_after_days
      ? ` +${step.delegate_after_days}d`
      : '';
    parts.push(`${t('policy_editor.chain.backup_line', { name: backupName })}${days}`);
  }
  if (!step.is_required) parts.push(t('policy_editor.chain.optional_flag'));
  return parts.join(' · ');
}

// ───────────────────────────────────────────────────────────────────────────
// ChainDiagram — body-only (no Card wrapper). Renders the circled-number
// caption + the chain. The parent page wraps both stages in one Card.
// ───────────────────────────────────────────────────────────────────────────

interface ChainDiagramProps {
  caption: StepCaption;
  steps: ChainStep[];
  setSteps: (s: ChainStep[]) => void;
  memberOptions: MemberOption[];
}

export function ChainDiagram({
  caption,
  steps,
  setSteps,
  memberOptions,
}: ChainDiagramProps) {
  const { t: tr } = useAppTranslation();
  const groups = groupByParallel(steps);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIndex = groups.findIndex(
      (g) => String(g[0].parallel_group) === active.id,
    );
    const toIndex = groups.findIndex(
      (g) => String(g[0].parallel_group) === over.id,
    );
    if (fromIndex < 0 || toIndex < 0) return;
    setSteps(reorderGroups(steps, fromIndex, toIndex));
  };

  const groupIds = groups.map((g) => String(g[0].parallel_group));

  return (
    <div className="space-y-3">
      {/* Caption: circled badge + two-part title */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-6 h-6 rounded-full border border-border flex items-center justify-center text-xs font-medium bg-background shrink-0">
          {caption.badge}
        </div>
        <span className="text-sm font-medium">{caption.primary}</span>
        <span className="text-xs text-muted-foreground">
          — {caption.secondary}
        </span>
      </div>

      {/* Chain */}
      {groups.length === 0 ? (
        <EmptySlotStandalone
          memberOptions={memberOptions}
          onPick={(role, userId) => {
            const seeded: ChainStep = {
              ...blankStep(1, 1),
              approver_role: role,
              approver_user_id: userId,
            };
            setSteps([seeded]);
          }}
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={groupIds}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-2">
              {groups.map((group) => (
                <ParallelStepRow
                  key={group[0].parallel_group}
                  group={group}
                  memberOptions={memberOptions}
                  onUpdate={(uiId, patch) =>
                    setSteps(updateStep(steps, uiId, patch))
                  }
                  onRemove={(uiId) => setSteps(removeStep(steps, uiId))}
                  onAddParallel={() =>
                    setSteps(
                      addParallelApprover(steps, group[0].parallel_group),
                    )
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* + Add another step */}
      {groups.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground h-7 -ml-2"
          onClick={() => setSteps(addNextStep(steps))}
        >
          <Plus className="h-3 w-3 mr-1" />
          {tr('policy_editor.chain.add_another_step')}
        </Button>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ParallelStepRow — drag handle + the row of cards (1+ side-by-side).
// ───────────────────────────────────────────────────────────────────────────

interface ParallelStepRowProps {
  group: ChainStep[];
  memberOptions: MemberOption[];
  onUpdate: (uiId: string, patch: Partial<ChainStep>) => void;
  onRemove: (uiId: string) => void;
  onAddParallel: () => void;
}

function ParallelStepRow({
  group,
  memberOptions,
  onUpdate,
  onRemove,
  onAddParallel,
}: ParallelStepRowProps) {
  const { t: tr } = useAppTranslation();
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
        'flex items-start gap-1',
        isDragging && 'ring-2 ring-primary rounded-lg',
      )}
    >
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none mt-3 px-1"
        aria-label={tr('policy_editor.chain.drag_reorder')}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex-1 min-w-0">
        <ParallelCardsRow
          group={group}
          memberOptions={memberOptions}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground h-6 mt-1 -ml-1"
          onClick={onAddParallel}
        >
          <Plus className="h-3 w-3 mr-1" />
          {tr('policy_editor.chain.add_parallel_approver')}
        </Button>
      </div>
    </div>
  );
}

function ParallelCardsRow({
  group,
  memberOptions,
  onUpdate,
  onRemove,
}: {
  group: ChainStep[];
  memberOptions: MemberOption[];
  onUpdate: (uiId: string, patch: Partial<ChainStep>) => void;
  onRemove: (uiId: string) => void;
}) {
  const { t: tr } = useAppTranslation();
  if (group.length === 1) {
    return (
      <ApproverCard
        step={group[0]}
        memberOptions={memberOptions}
        onUpdate={(patch) => onUpdate(group[0].uiId, patch)}
        onRemove={() => onRemove(group[0].uiId)}
      />
    );
  }
  return (
    <>
      {/* Desktop: side-by-side */}
      <div className="hidden sm:flex items-stretch gap-2">
        {group.map((step, idx) => (
          <Fragment key={step.uiId}>
            <div className="flex-1 min-w-0">
              <ApproverCard
                step={step}
                memberOptions={memberOptions}
                onUpdate={(patch) => onUpdate(step.uiId, patch)}
                onRemove={() => onRemove(step.uiId)}
              />
            </div>
            {idx < group.length - 1 && (
              <div className="flex items-center px-1 text-[10px] font-medium text-muted-foreground leading-tight text-center whitespace-nowrap">
                {tr('policy_editor.chain.and_line1')}<br />{tr('policy_editor.chain.and_line2')}<br />{tr('policy_editor.chain.and_line3')}<br />{tr('policy_editor.chain.and_line4')}
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {/* Mobile: stacked with full-width connector */}
      <div className="flex flex-col gap-2 sm:hidden">
        {group.map((step, idx) => (
          <Fragment key={step.uiId}>
            <ApproverCard
              step={step}
              memberOptions={memberOptions}
              onUpdate={(patch) => onUpdate(step.uiId, patch)}
              onRemove={() => onRemove(step.uiId)}
            />
            {idx < group.length - 1 && (
              <div className="text-center text-xs font-medium text-muted-foreground">
                {tr('policy_editor.chain.and_same_time_mobile')}
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ApproverCard — populated state. Avatar + name + role line + MoreVertical.
// Two popovers (picker + backup-config) anchor inside the card; both also
// reachable via the MoreVertical menu.
// ───────────────────────────────────────────────────────────────────────────

interface ApproverCardProps {
  step: ChainStep;
  memberOptions: MemberOption[];
  onUpdate: (patch: Partial<ChainStep>) => void;
  onRemove: () => void;
}

export function ApproverCard({
  step,
  memberOptions,
  onUpdate,
  onRemove,
}: ApproverCardProps) {
  const { t: tr } = useAppTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const display = approverDisplayFor(step, memberOptions);

  if (display.empty) {
    return (
      <EmptyApproverSlot
        memberOptions={memberOptions}
        onPick={(role, userId) =>
          onUpdate({ approver_role: role, approver_user_id: userId })
        }
        onRemove={onRemove}
      />
    );
  }

  const colors = AVATAR_COLORS[display.colorIndex];
  const secondary = formatSecondaryLine(step, memberOptions, display.secondary);

  return (
    <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
      <Popover open={backupOpen} onOpenChange={setBackupOpen}>
        <div className="flex items-center gap-3 p-3 bg-card border rounded-lg relative">
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 hover:ring-2 hover:ring-primary/30 transition-all',
                colors.bg,
                colors.text,
              )}
              aria-label={tr('policy_editor.chain.change_approver')}
              onClick={() => setPickerOpen(true)}
            >
              {display.initials}
            </button>
          </PopoverTrigger>
          <button
            type="button"
            className="flex-1 min-w-0 text-left"
            onClick={() => setPickerOpen(true)}
          >
            <div className="text-sm font-medium truncate">{display.primary}</div>
            <div className="text-xs text-muted-foreground truncate">
              {secondary || ' '}
            </div>
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={tr('policy_editor.chain.approver_options')}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                {tr('policy_editor.chain.choose_someone_else')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setBackupOpen(true)}>
                {step.delegate_user_id
                  ? tr('policy_editor.chain.edit_backup')
                  : tr('policy_editor.chain.add_backup')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => onUpdate({ is_required: !step.is_required })}
              >
                {step.is_required ? tr('policy_editor.chain.mark_optional') : tr('policy_editor.chain.mark_required')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={onRemove}
                className="text-destructive focus:text-destructive"
              >
                {tr('policy_editor.chain.remove_approver')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Backup popover anchored at the bottom-right of the card */}
          <PopoverTrigger asChild>
            <span
              aria-hidden
              className="absolute bottom-0 right-8 w-px h-px pointer-events-none"
            />
          </PopoverTrigger>
        </div>

        <PopoverContent className="w-72 p-0" align="start">
          <ApproverPickerContent
            memberOptions={memberOptions}
            currentRole={step.approver_role}
            currentUserId={step.approver_user_id}
            includeRoles={true}
            allowClear={false}
            onSelectRole={(role) => {
              onUpdate({ approver_role: role, approver_user_id: null });
              setPickerOpen(false);
            }}
            onSelectUser={(userId) => {
              onUpdate({ approver_user_id: userId, approver_role: null });
              setPickerOpen(false);
            }}
          />
        </PopoverContent>

        <PopoverContent className="w-72" align="end">
          <BackupEditor
            memberOptions={memberOptions}
            currentUserId={step.delegate_user_id}
            currentDays={step.delegate_after_days}
            onChange={(uid, days) =>
              onUpdate({ delegate_user_id: uid, delegate_after_days: days })
            }
          />
        </PopoverContent>
      </Popover>
    </Popover>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Empty approver slot — two flavors. EmptyApproverSlot is for an existing
// step row that has no approver chosen; EmptySlotStandalone is for the
// brand-new chain (no rows yet) — picking immediately seeds row #1.
// ───────────────────────────────────────────────────────────────────────────

interface EmptyApproverSlotProps {
  memberOptions: MemberOption[];
  onPick: (role: string | null, userId: string | null) => void;
  onRemove?: () => void;
}

function EmptyApproverSlot({
  memberOptions,
  onPick,
  onRemove,
}: EmptyApproverSlotProps) {
  const { t: tr } = useAppTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-stretch gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex-1 p-3 border-2 border-dashed rounded-lg text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors flex items-center justify-center gap-2 text-sm"
          >
            <UserPlus className="w-4 h-4" />
            {tr('policy_editor.chain.choose_approver')}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <ApproverPickerContent
            memberOptions={memberOptions}
            currentRole={null}
            currentUserId={null}
            includeRoles={true}
            allowClear={false}
            onSelectRole={(role) => {
              onPick(role, null);
              setOpen(false);
            }}
            onSelectUser={(userId) => {
              onPick(null, userId);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-auto w-7 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title={tr('policy_editor.chain.remove_empty_slot')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

interface EmptySlotStandaloneProps {
  memberOptions: MemberOption[];
  onPick: (role: string | null, userId: string | null) => void;
}

function EmptySlotStandalone({
  memberOptions,
  onPick,
}: EmptySlotStandaloneProps) {
  return (
    <EmptyApproverSlot memberOptions={memberOptions} onPick={onPick} />
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ApproverPickerContent — typeahead Command palette body. Lives inside a
// PopoverContent so callers control open state.
// ───────────────────────────────────────────────────────────────────────────

interface ApproverPickerContentProps {
  memberOptions: MemberOption[];
  currentRole: string | null;
  currentUserId: string | null;
  includeRoles: boolean;
  allowClear: boolean;
  onSelectRole?: (role: string) => void;
  onSelectUser?: (userId: string) => void;
  onClear?: () => void;
}

function ApproverPickerContent({
  memberOptions,
  currentRole,
  currentUserId,
  includeRoles,
  allowClear,
  onSelectRole,
  onSelectUser,
  onClear,
}: ApproverPickerContentProps) {
  const { t: tr } = useAppTranslation();
  return (
    <Command>
      <CommandInput
        placeholder={
          includeRoles
            ? tr('policy_editor.chain.search_roles_people')
            : tr('policy_editor.chain.search_people')
        }
      />
      <CommandList>
        <CommandEmpty>{tr('policy_editor.chain.no_matches')}</CommandEmpty>

        {includeRoles && (
          <CommandGroup heading={tr('policy_editor.chain.anyone_with_role')}>
            {FUNCTIONAL_ROLE_OPTIONS.map((r) => (
              <CommandItem
                key={`role-${r.value}`}
                value={`role ${tr(r.labelKey)}`}
                onSelect={() => onSelectRole?.(r.value)}
              >
                <Users className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                <span className="flex-1">{tr(r.labelKey)}</span>
                {currentRole === r.value && (
                  <Check className="h-3.5 w-3.5 text-primary" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {includeRoles && memberOptions.length > 0 && <CommandSeparator />}

        <CommandGroup heading={tr('policy_editor.chain.a_specific_person')}>
          {memberOptions.length === 0 ? (
            <CommandItem disabled value="__none__">
              <span className="text-muted-foreground text-xs">
                {tr('policy_editor.chain.no_members_loaded')}
              </span>
            </CommandItem>
          ) : (
            memberOptions.map((m) => (
              <CommandItem
                key={`user-${m.id}`}
                value={`user ${m.label}`}
                onSelect={() => onSelectUser?.(m.id)}
              >
                <UserCircle2 className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                <span className="flex-1 truncate">{m.label}</span>
                {currentUserId === m.id && (
                  <Check className="h-3.5 w-3.5 text-primary shrink-0 ml-1" />
                )}
              </CommandItem>
            ))
          )}
        </CommandGroup>

        {allowClear && (currentRole || currentUserId) && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem value="__clear__" onSelect={() => onClear?.()}>
                <X className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                <span className="text-muted-foreground">{tr('policy_editor.chain.clear_selection')}</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// BackupEditor — popover content for setting backup user + escalation days.
// ───────────────────────────────────────────────────────────────────────────

interface BackupEditorProps {
  memberOptions: MemberOption[];
  currentUserId: string | null;
  currentDays: number | null;
  onChange: (userId: string | null, days: number | null) => void;
}

function BackupEditor({
  memberOptions,
  currentUserId,
  currentDays,
  onChange,
}: BackupEditorProps) {
  const { t: tr } = useAppTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const current = memberOptions.find((m) => m.id === currentUserId);
  const currentLabel =
    current?.label.replace(/\s*\([^)]+\)\s*$/, '') ??
    tr('policy_editor.chain.no_backup_chosen');

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium">{tr('policy_editor.chain.backup_title')}</p>
      <p className="text-[10px] text-muted-foreground">
        {tr('policy_editor.chain.backup_hint')}
      </p>

      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between font-normal text-sm h-9"
          >
            <span className={cn('truncate', !currentUserId && 'text-muted-foreground')}>
              {currentLabel}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <ApproverPickerContent
            memberOptions={memberOptions}
            currentRole={null}
            currentUserId={currentUserId}
            includeRoles={false}
            allowClear={!!currentUserId}
            onSelectUser={(uid) => {
              onChange(uid, currentDays ?? 3);
              setPickerOpen(false);
            }}
            onClear={() => {
              onChange(null, null);
              setPickerOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide">
          {tr('policy_editor.chain.forward_after_days')}
        </Label>
        <Input
          type="number"
          min={1}
          value={currentDays ?? ''}
          onChange={(e) =>
            onChange(
              currentUserId,
              e.target.value === '' ? null : parseInt(e.target.value, 10),
            )
          }
          placeholder="—"
          className="h-8 text-sm"
          disabled={!currentUserId}
        />
      </div>
    </div>
  );
}

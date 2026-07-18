import { useState, useEffect, useMemo, useRef, type ElementType, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Search,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Archive,
  ArchiveRestore,
  Building2,
  MoreHorizontal,
  Download,
  ChevronRight,
  Trash2,
  RotateCcw,
  Columns3,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { AppLayout } from '@/components/layout/AppLayout';
import { AppHeader } from '@/components/layout/AppHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ArchiveLeaseDialog } from '@/components/leases/ArchiveLeaseDialog';
import { DeleteLeaseWithRetentionDialog } from '@/components/leases/DeleteLeaseWithRetentionDialog';
import { LeaseUploadModal } from '@/components/leases/LeaseUploadModal';
import { LimitReachedDialog } from '@/components/leases/LimitReachedDialog';
import { useWorkspaceQuota } from '@/hooks/useWorkspaceQuota';
import { AddLeaseDialog } from '@/components/leases/AddLeaseDialog';
import { EmptyLeaseState } from '@/components/leases/EmptyLeaseState';
import { LeaseStatusBadge } from '@/components/leases/LeaseStatusBadge';
import { LeaseRequestForm } from '@/components/workflow/LeaseRequestForm';
import { supabase } from '@/integrations/supabase/client';
import { formatLocalizedCurrency, formatLocalizedDate, formatLocalizedNumber } from '@/lib/dateFormatters';
import { getMonthlyRent } from '@/lib/leaseCalculations';
import { rowsToCsv } from '@/lib/csv';
import { prettyAssetType, assetAbbreviation } from '@/lib/assetTypes';
import {
  getPropertyAddress,
  getLeaseEnd,
  getDaysUntilExpiration,
  statusText,
  isArchivedDisplay,
  isExpiryRelevant,
  makeStatusSortKey,
  makeLeaseComparator,
} from '@/lib/leaseSort';
import { cn } from '@/lib/utils';
import {
  LEASE_COLUMN_WIDTHS_KEY,
  DEFAULT_COLUMN_WIDTHS,
  parseStoredColumnWidths,
  serializeColumnWidths,
  applyBoundaryResize,
  LEASE_HIDDEN_COLS_KEY,
  HIDEABLE_COLUMNS,
  DEFAULT_HIDDEN_COLUMNS,
  parseStoredHidden,
  serializeHidden,
  toggleHidden,
  visibleResizeBoundaries,
  autoFitColumn,
  type LeaseColumnKey,
  type ColumnWidths,
} from '@/lib/leaseColumnPrefs';
import { useLanguage } from '@/contexts/LanguageContext';
import { useApp } from '@/contexts/AppContext';
import { isWorkspaceReadOnly } from '@/lib/workspaceReadOnly';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface LeaseRow {
  id: string;
  filename: string;
  status: string;
  lifecycle_status: string | null;
  request_title: string | null;
  landlord_name: string | null;
  asset_type: string | null;
  property_address: string | null;
  lease_start: string | null;
  lease_end: string | null;
  executed_expiry_date: string | null;
  square_footage: number | null;
  executed_monthly_payment: number | null;
  current_monthly_rent: number | null;
  monthly_payment: number | null;
  extracted_json: Record<string, unknown> | null;
  archived?: boolean | null;
  rent_schedules: {
    period_start: string;
    period_end: string | null;
    monthly_amount: number;
  }[] | null;
}

type SortField = 'property' | 'asset_type' | 'landlord' | 'monthly_rent' | 'lease_start' | 'lease_end' | 'sqft' | 'days_to_expiry' | 'status';
type SortDirection = 'asc' | 'desc';
// The Leases page is the lease PORTFOLIO (executed / active / expired). The
// archive scope — not the workflow lifecycle — is the page's primary axis.
// In-flight (approval) leases live on the Approvals page (see redirect below).
type StatusScope = 'all' | 'active' | 'archived';

// Lifecycle states that belong to the portfolio surface. In-flight/approval
// states are intentionally excluded — Approvals owns that lifecycle.
const PORTFOLIO_STATUSES = ['executed', 'active', 'fully_executed', 'expired', 'chain_violation'];

export default function Leases() {
  const navigate = useNavigate();
  const { t, language } = useLanguage();
  const formatCurrency = (value: number | null | undefined) => formatLocalizedCurrency(value, language);
  const { workspace, user, userRole, refreshProfile, isLoading: appLoading } = useApp();
  // #136/#137: hide intake/archive affordances for ANY read-only workspace —
  // Vault OR a cancellation-grace/soft-deleted one (the server also blocks).
  const isReadOnly = isWorkspaceReadOnly(workspace);
  // Archive is admin/owner-only (server-enforced by the #78 trigger).
  const isAdmin = userRole === 'admin' || userRole === 'owner';
  const [searchParams] = useSearchParams();
  const quota = useWorkspaceQuota();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false); // ARCHIVE confirm dialog (legacy name)
  const [retentionDeleteOpen, setRetentionDeleteOpen] = useState(false); // permanent-delete (14-day retention) dialog
  const [deletePending, setDeletePending] = useState(false);
  const [addLeaseDialogOpen, setAddLeaseDialogOpen] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [limitWallOpen, setLimitWallOpen] = useState(false);

  // Limit wall gate — at the cap (with no spendable credit), intake entry
  // points open the wall instead of the chooser. The server re-checks in
  // process_lease, so this is UX, not enforcement.
  const handleAddLease = () => {
    if (quota.blocked) {
      setLimitWallOpen(true);
    } else {
      setAddLeaseDialogOpen(true);
    }
  };
  const [selectedLease, setSelectedLease] = useState<LeaseRow | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expirationFilter, setExpirationFilter] = useState<'all' | '30' | '90' | '120'>(
    (['30', '90', '120'].includes(searchParams.get('expiring') ?? '') ? searchParams.get('expiring') : 'all') as 'all' | '30' | '90' | '120'
  );
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('lease_end');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  // Resizable, persisted column widths (percentages that sum to 100 — with the
  // table-fixed layout the table always fits its container). Read synchronously
  // so the first paint uses the saved layout, not a flash of the defaults.
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_COLUMN_WIDTHS };
    try {
      return parseStoredColumnWidths(window.localStorage.getItem(LEASE_COLUMN_WIDTHS_KEY));
    } catch {
      return { ...DEFAULT_COLUMN_WIDTHS };
    }
  });
  const tableRef = useRef<HTMLTableElement>(null);
  // User-hidden columns (the "Columns" menu). Read synchronously like the widths.
  const [hiddenColumns, setHiddenColumns] = useState<LeaseColumnKey[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      return parseStoredHidden(window.localStorage.getItem(LEASE_HIDDEN_COLS_KEY));
    } catch {
      return [];
    }
  });
  // Single scope control (replaces the Active/Approval tabs + the "Show
  // archived" toggle). Default ALL = active + archived together. Honors a
  // ?status= deep-link.
  const [scope, setScope] = useState<StatusScope>(
    (['active', 'archived', 'all'].includes(searchParams.get('status') ?? '')
      ? searchParams.get('status')
      : 'all') as StatusScope,
  );
  const [leases, setLeases] = useState<LeaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-workspace asset-type abbreviations (label -> abbr). Tolerant load: a
  // pre-migration deploy (column absent) leaves this {} → built-in defaults.
  const [assetAbbr, setAssetAbbr] = useState<Record<string, string>>({});

  // Approvals moved off this page — bounce any legacy ?view=approval deep-link
  // to the Approvals surface that now owns that lifecycle.
  useEffect(() => {
    if (searchParams.get('view') === 'approval') navigate('/app/approvals', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workspace?.id) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await (supabase as any)
        .from('workspaces')
        .select('asset_type_abbreviations')
        .eq('id', workspace.id)
        .single();
      if (cancelled || error || !data) return;
      const abbr = data.asset_type_abbreviations;
      if (abbr && typeof abbr === 'object' && !Array.isArray(abbr)) {
        setAssetAbbr(abbr as Record<string, string>);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace?.id]);

  const expiryFilters = [
    { value: 'all', label: t('leases.expiry_all') },
    { value: '30', label: t('leases.expiring_le_30') },
    { value: '90', label: t('leases.expiring_le_90') },
    { value: '120', label: t('leases.expiring_le_120') },
  ];

  const fetchLeases = async () => {
    // No active workspace: stop the spinner instead of hanging forever (the
    // early return used to skip the finally that clears `loading`). The
    // render shows the app-level spinner while the workspace is still
    // resolving (appLoading), then the empty state once it's settled.
    if (!workspace?.id) {
      setLeases([]);
      setLoading(false);
      return;
    }
    try {
      // Workspace scoping is mandatory: a user who is a member of multiple
      // workspaces would otherwise see every workspace's leases mixed together
      // (RLS allows them all; UI must scope to the active one).
      let query = (supabase as any)
        .from('leases')
        .select(
          'id, filename, status, lifecycle_status, request_title, landlord_name, asset_type, ' +
          'property_address, lease_start, lease_end, executed_expiry_date, square_footage, ' +
          'executed_monthly_payment, current_monthly_rent, monthly_payment, extracted_json, archived, ' +
          'rent_schedules(period_start, period_end, monthly_amount)'
        )
        .eq('workspace_id', workspace.id)
        .order('lease_end', { ascending: true });

      const portfolioList = PORTFOLIO_STATUSES.join(',');
      if (scope === 'active') {
        query = query.in('lifecycle_status', PORTFOLIO_STATUSES).eq('archived', false);
      } else if (scope === 'archived') {
        // Archived-only, including NULL-lifecycle rows (failed/processing uploads
        // and amendments never get one) so an archived failed item is still
        // reachable here to restore (#91).
        query = query
          .eq('archived', true)
          .or(`lifecycle_status.in.(${portfolioList}),lifecycle_status.is.null`);
      } else {
        // ALL: active portfolio (any archived flag) + archived failed/NULL rows.
        // Non-archived drafts/failures stay out of the portfolio list (they live
        // in ImportHistory / processing).
        query = query.or(
          `lifecycle_status.in.(${portfolioList}),and(archived.eq.true,lifecycle_status.is.null)`,
        );
      }

      const { data, error } = await query;

      if (error) throw error;
      setLeases((data || []) as unknown as LeaseRow[]);
    } catch (error) {
      console.error('Error fetching leases:', error);
      toast.error(t('leases.load_failed'), { id: 'lease-list' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeases();
    // re-fetch when the scope filter changes OR the active workspace switches —
    // without the workspace dep, switching workspaces would leave the previous
    // workspace's leases on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, workspace?.id]);

  const handleArchiveClick = (lease: LeaseRow) => {
    setSelectedLease(lease);
    setDeleteDialogOpen(true);
  };

  // #79: the list action is restorable ARCHIVE, not hard-delete. Sets
  // archived=true; the #78 trigger stamps archived_by/archived_at server-side
  // (the client values here are overridden) and enforces admin/owner.
  // Toasts carry a stable id so rapid actions replace rather than stack.
  const handleArchiveConfirm = async () => {
    if (!selectedLease) return;
    try {
      const { error } = await supabase
        .from('leases')
        .update({ archived: true, archived_at: new Date().toISOString(), archived_by: user?.id ?? null })
        .eq('id', selectedLease.id);
      if (error) throw error;
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: selectedLease.id,
        user_id: user?.id ?? null,
        activity_type: 'lease_archived',
        details: {},
      } as any);
      if (auditError) console.error('Archive audit insert failed:', auditError.message);
      toast.success(t('archive.list_archived_toast'), { id: 'lease-action' });
      setDeleteDialogOpen(false);
      setSelectedLease(null);
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Archive error:', error);
      toast.error(t('archive.list_archive_failed'), { id: 'lease-action' });
    }
  };

  // In-list restore (#91): mirrors ArchiveButton — non-destructive, admin-only
  // (the #78 trigger enforces server-side), logs lease_restored.
  const handleRestore = async (lease: LeaseRow) => {
    try {
      const { error } = await supabase
        .from('leases')
        .update({ archived: false, archived_at: null, archived_by: null })
        .eq('id', lease.id)
        .select('id');
      if (error) throw error;
      const { error: auditError } = await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user?.id ?? null,
        activity_type: 'lease_restored',
        details: {},
      } as any);
      if (auditError) console.error('Restore audit insert failed:', auditError.message);
      toast.success(t('archive.unarchived_toast'), { id: 'lease-action' });
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Restore error:', error);
      toast.error(t('archive.failed'), { id: 'lease-action' });
    }
  };

  const handleDeleteClick = (lease: LeaseRow) => {
    setSelectedLease(lease);
    setRetentionDeleteOpen(true);
  };

  // Phase 3 permanent delete: soft-delete via the service-role delete-lease
  // edge function (14-day restore-on-request window, then the retention cron
  // purges it). The lease vanishes from every surface immediately (hiding RLS).
  // Toast shares the stable 'lease-action' id so it never stacks with
  // archive/restore. Admin-only + always-available is enforced server-side too.
  const handleDeleteConfirm = async () => {
    if (!selectedLease || deletePending) return;
    setDeletePending(true);
    const leaseId = selectedLease.id; // capture before we clear selection (for Undo)
    try {
      const { data, error } = await supabase.functions.invoke('delete-lease', {
        body: { leaseId },
      });
      if (error || !(data as { ok?: boolean } | null)?.ok) {
        throw error ?? new Error('delete-lease returned not-ok');
      }
      // Misclick safety: an Undo on the success toast restores the lease in the
      // 14-day window (calls restore-lease, which the soft-delete left ready).
      toast.success(t('leases.delete_success'), {
        id: 'lease-action',
        action: { label: t('common.undo'), onClick: () => handleUndoDelete(leaseId) },
      });
      setRetentionDeleteOpen(false);
      setSelectedLease(null);
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error(t('leases.delete_failed'), { id: 'lease-action' });
    } finally {
      setDeletePending(false);
    }
  };

  // Undo a just-deleted lease (the soft-delete is restorable for 14 days). Also
  // the in-product restore path for an accidental delete; ops can restore later
  // via the same restore-lease function. Shares the 'lease-action' toast id.
  const handleUndoDelete = async (leaseId: string) => {
    try {
      const { data, error } = await supabase.functions.invoke('restore-lease', {
        body: { leaseId },
      });
      if (error || !(data as { ok?: boolean } | null)?.ok) {
        throw error ?? new Error('restore-lease returned not-ok');
      }
      toast.success(t('archive.unarchived_toast'), { id: 'lease-action' });
      await refreshProfile?.();
      fetchLeases();
    } catch (error) {
      console.error('Undo delete error:', error);
      toast.error(t('leases.delete_undo_failed'), { id: 'lease-action' });
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="h-4 w-4" />;
    return sortDirection === 'asc' ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />;
  };

  // Persist column widths whenever they change (resize / reset).
  useEffect(() => {
    try {
      window.localStorage.setItem(LEASE_COLUMN_WIDTHS_KEY, serializeColumnWidths(columnWidths));
    } catch {
      /* localStorage unavailable (private mode / quota) — non-fatal */
    }
  }, [columnWidths]);

  // Persist hidden columns.
  useEffect(() => {
    try {
      window.localStorage.setItem(LEASE_HIDDEN_COLS_KEY, serializeHidden(hiddenColumns));
    } catch {
      /* non-fatal */
    }
  }, [hiddenColumns]);

  const colVisible = (key: LeaseColumnKey) => !hiddenColumns.includes(key);

  // Resize-handle partners recomputed from visibility, so a hidden column never
  // breaks a pairing (the handle drives a column + its next VISIBLE neighbor).
  const resizeBoundaries = useMemo(() => visibleResizeBoundaries(hiddenColumns), [hiddenColumns]);
  const nextResizable = (key: LeaseColumnKey): LeaseColumnKey | null =>
    resizeBoundaries.find((b) => b.left === key)?.right ?? null;

  // i18n label for a hideable column key (the Columns menu).
  const columnLabel = (key: LeaseColumnKey): string => {
    const labels: Partial<Record<LeaseColumnKey, string>> = {
      asset_type: t('leases.type'),
      landlord: t('leases.landlord'),
      lease_start: t('leases.start'),
      lease_end: t('leases.end'),
      days_to_expiry: t('leases.days_to_expiry'),
      sqft: t('leases.sqft'),
    };
    return labels[key] ?? key;
  };

  // Double-click a column border → auto-fit THAT column to its widest cell
  // (Excel/Sheets convention), redistributing so the table still fits.
  const autoFit = (key: LeaseColumnKey) => {
    const table = tableRef.current;
    if (!table) return;
    const cells = table.querySelectorAll<HTMLElement>(`[data-col="${key}"]`);
    if (!cells.length) return;
    let max = 0;
    cells.forEach((cell) => {
      const inner = cell.firstElementChild as HTMLElement | null;
      max = Math.max(max, inner ? inner.scrollWidth : cell.scrollWidth);
    });
    const CELL_PADDING_PX = 24; // px-3 both sides
    // Cap the target so auto-fitting a very long value (a 60-char address) can't
    // pull every other column down toward the floor and crush them.
    const targetPct = Math.min(40, ((max + CELL_PADDING_PX) / (table.offsetWidth || 1)) * 100);
    setColumnWidths((w) => autoFitColumn(w, key, targetPct));
  };

  const resetColumnWidths = () => setColumnWidths({ ...DEFAULT_COLUMN_WIDTHS });
  // True when the layout matches defaults — gates the visible "Reset columns"
  // recovery affordance (the one escape from a dragged-too-far column).
  const widthsAreDefault = useMemo(
    () =>
      (Object.keys(DEFAULT_COLUMN_WIDTHS) as LeaseColumnKey[]).every(
        (k) => columnWidths[k] === DEFAULT_COLUMN_WIDTHS[k],
      ),
    [columnWidths],
  );
  // True when hidden columns match the density default (order-insensitive) —
  // so "Reset columns" is correctly disabled on a pristine first visit.
  const hiddenAtDefault = useMemo(() => {
    if (hiddenColumns.length !== DEFAULT_HIDDEN_COLUMNS.length) return false;
    const set = new Set(hiddenColumns);
    return DEFAULT_HIDDEN_COLUMNS.every((k) => set.has(k));
  }, [hiddenColumns]);

  // Drag the boundary between two adjacent columns: the left grows by the same
  // amount the right shrinks, so the total stays 100 and the table keeps
  // fitting. Pointer-driven; the handle only renders on lg+ where the full
  // column set is visible (so the boundary pairing is exact).
  const startColumnResize = (
    leftKey: LeaseColumnKey,
    rightKey: LeaseColumnKey,
    e: ReactPointerEvent<HTMLDivElement>,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const tableWidth = tableRef.current?.offsetWidth ?? 0;
    if (!tableWidth) return;
    const startX = e.clientX;
    const startWidths = columnWidths;
    // Lock the resize cursor + suppress text selection for the whole drag, so a
    // fast pointer that outruns the 2px handle still reads as "grabbed".
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: PointerEvent) => {
      const deltaPct = ((ev.clientX - startX) / tableWidth) * 100;
      setColumnWidths(applyBoundaryResize(startWidths, leftKey, rightKey, deltaPct));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // One sortable + resizable header cell. `key` doubles as the sort field and
  // the width key; `nextKey` is the resizable column to the right (the divider
  // drag partner) or null for the last resizable column.
  const renderSortHead = (
    key: SortField,
    label: string,
    Icon: ElementType | null,
    nextKey: LeaseColumnKey | null,
    responsiveClass = '',
    align: 'left' | 'right' = 'left',
  ) => (
    <TableHead data-col={key} className={cn('relative', align === 'right' && 'text-right', responsiveClass)} style={{ width: `${columnWidths[key]}%` }}>
      <Button
        variant="ghost"
        size="sm"
        className={cn('h-8 max-w-full', align === 'right' ? '-mr-3 w-full justify-end' : '-ml-3')}
        onClick={() => handleSort(key)}
      >
        {Icon && <Icon className="mr-2 h-4 w-4 shrink-0" />}
        <span className="truncate">{label}</span>
        <span className="ml-1 shrink-0">{getSortIcon(key)}</span>
      </Button>
      {nextKey && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('leases.resize_column')}
          title={t('leases.resize_column')}
          onPointerDown={(e) => startColumnResize(key, nextKey, e)}
          onDoubleClick={() => autoFit(key)}
          className="group absolute right-0 top-0 z-10 hidden h-full w-2 cursor-col-resize touch-none select-none lg:flex lg:items-center lg:justify-center"
        >
          {/* Faint persistent rule so columns read as draggable; brightens on hover. */}
          <span className="h-1/2 w-px bg-border transition-all group-hover:h-full group-hover:w-0.5 group-hover:bg-primary" />
        </div>
      )}
    </TableHead>
  );

  const getExpirationBadge = (days: number | null) => {
    if (days === null) return <span className="text-muted-foreground">&mdash;</span>;
    // Overdue (a still-live lease past its end date): show the signed day
    // overage in red, NOT the word "Expired" — the Status column owns that word
    // (this cell only renders for live leases via isExpiryRelevant). A bare
    // "-42d" beside a green "Active" reads as cryptic, so a tooltip spells it
    // out. #154.
    if (days < 0) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive" className="cursor-default tabular-nums">{days}d</Badge>
          </TooltipTrigger>
          <TooltipContent>{t('leases.overdue_tooltip', { days: Math.abs(days) })}</TooltipContent>
        </Tooltip>
      );
    }
    if (days <= 30) return <Badge variant="destructive">{days}d</Badge>;
    if (days <= 60) return <Badge variant="warning">{days}d</Badge>;
    if (days <= 90) return <Badge variant="secondary">{days}d</Badge>;
    return <span className="text-sm text-muted-foreground">{days}d</span>;
  };

  // No "SF" suffix — the "Sq. Ft." column header carries the unit (avoids the
  // redundant double-unit and frees the tightest column's width). #154 round 2.
  // Locale-aware grouping so es groups 44.833 to match the currency beside it.
  const formatSqFt = (sqft: number | null) => formatLocalizedNumber(sqft, language);

  // Canonical locale-aware formatter (matches the currency formatter's locale)
  // — fixes English-only months for es users and the date-only parse. "Mar 1,
  // 2026" / "1 mar 2026".
  const formatDate = (dateStr: string | null) => formatLocalizedDate(dateStr, language);

  // Sort key for the Status column (pure helper in leaseSort.ts). An archived
  // lease shows ONLY the "Archived" badge (lifecycle suppressed in the cell),
  // so it must also sort as "Archived" — the i18n'd label is injected here.
  const statusSortKey = makeStatusSortKey(t('archive.deleted_badge'));

  // Active = live portfolio (not archived). Drives the header rent total.
  const activeLeases = useMemo(
    () => leases.filter((l) =>
      !l.archived &&
      (l.lifecycle_status === 'active' || l.lifecycle_status === 'executed' || l.lifecycle_status === 'fully_executed'),
    ),
    [leases],
  );

  const totalMonthlyRent = useMemo(
    () => activeLeases.reduce((sum, l) => sum + getMonthlyRent(l), 0),
    [activeLeases],
  );

  const headerSubtitle = useMemo(() => {
    const total = leases.length;
    const active = activeLeases.length;
    if (totalMonthlyRent > 0) {
      // activePart is a pluralized sub-key so es agrees at n=1 ("1 activo",
      // not "1 activos") — i18next can't pluralize mid-string (#152 LOW).
      return t('leases.subtitle_rent', {
        rent: formatCurrency(totalMonthlyRent),
        activePart: t('leases.subtitle_active', { count: active }),
        total,
      });
    }
    return t('leases.subtitle_count', { count: total });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMonthlyRent, activeLeases, leases]);

  // Distinct asset types present in the loaded set — drives the Type filter
  // without a second fetch (workspace-configured shorthands arrive in Phase 2).
  const assetTypeOptions = useMemo(
    () => Array.from(new Set(leases.map((l) => l.asset_type).filter((x): x is string => !!x))).sort(),
    [leases],
  );

  const filteredAndSortedLeases = useMemo(() => {
    const searchLower = searchQuery.trim().toLowerCase();
    const result = leases.filter((lease) => {
      // Search across ANY visible attribute (property, type, landlord, status,
      // dates, sq ft, rent) — one lowercased haystack.
      const haystack = [
        getPropertyAddress(lease),
        prettyAssetType(lease.asset_type),
        lease.landlord_name,
        statusText(lease),
        formatDate(lease.lease_start),
        formatDate(getLeaseEnd(lease)),
        lease.square_footage ? `${lease.square_footage} sf` : '',
        getMonthlyRent(lease) ? formatCurrency(getMonthlyRent(lease)) : '',
      ].filter(Boolean).join(' ').toLowerCase();
      const matchesSearch = !searchLower || haystack.includes(searchLower);

      const matchesType = typeFilter === 'all' || lease.asset_type === typeFilter;

      let matchesExpiration = true;
      if (expirationFilter !== 'all') {
        const days = getDaysUntilExpiration(getLeaseEnd(lease));
        // All bands are cumulative "within N days" so the count on a linking
        // surface (the dashboard "Expiring ≤ 120 days" tile) matches the list
        // it opens — a band like 91–120 hid the most-urgent ≤90-day leases.
        const filterDays = parseInt(expirationFilter, 10);
        matchesExpiration = days !== null && days >= 0 && days <= filterDays;
      }

      return matchesSearch && matchesType && matchesExpiration;
    });

    result.sort(makeLeaseComparator(sortField, sortDirection, statusSortKey));

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leases, expirationFilter, typeFilter, searchQuery, sortField, sortDirection]);

  // Export the CURRENT filtered + sorted rows (WYSIWYG) as CSV.
  const handleExportCsv = () => {
    if (filteredAndSortedLeases.length === 0) {
      toast.error(t('leases.export_empty'), { id: 'lease-export' });
      return;
    }
    const records = filteredAndSortedLeases.map((l) => ({
      Property: getPropertyAddress(l),
      Type: prettyAssetType(l.asset_type),
      Landlord: l.landlord_name ?? '',
      'Monthly Rent': getMonthlyRent(l) || '',
      Start: l.lease_start ?? '',
      End: getLeaseEnd(l) ?? '',
      'Sq Ft': l.square_footage ?? '',
      Status: statusText(l),
      Archived: l.archived ? 'yes' : 'no',
    }));
    const csv = rowsToCsv(records);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leases-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(t('leases.export_success', { count: records.length }), { id: 'lease-export' });
  };

  return (
    <AppLayout>
      <AppHeader
        title={t('leases.title')}
        subtitle={headerSubtitle}
        actions={
          isReadOnly ? undefined : (
            <Button variant="accent" onClick={handleAddLease}>
              <Plus className="mr-2 h-4 w-4" />
              {t('leases.add_lease')}
            </Button>
          )
        }
      />

      <PageLayout width="wide" spacing="space-y-4">
        {loading || appLoading ? (
          <div className="flex h-[40vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : leases.length === 0 && scope === 'all' ? (
          // Only a truly-empty workspace (no portfolio leases at all) earns the
          // marketing card. A scoped-empty Active/Archived slice is handled in
          // the toolbar branch below so the scope control stays visible and the
          // user is never walled off from leases they actually have. #154.
          <EmptyLeaseState onAddLease={handleAddLease} readOnly={isReadOnly} />
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder={t('leases.search_placeholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              {/* Status — the single scope control (Active / Archived / All). */}
              <Select value={scope} onValueChange={(v) => setScope(v as StatusScope)}>
                <SelectTrigger className="w-full sm:w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('leases.all_leases')}</SelectItem>
                  <SelectItem value="active">{t('leases.scope_active')}</SelectItem>
                  <SelectItem value="archived">{t('leases.scope_archived')}</SelectItem>
                </SelectContent>
              </Select>
              {/* Type filter — distinct asset types present in the list. */}
              {assetTypeOptions.length > 0 && (
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[160px]">
                    <SelectValue placeholder={t('leases.type_all')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('leases.type_all')}</SelectItem>
                    {assetTypeOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>{prettyAssetType(opt)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* Expiry — distinct from Status; keeps the Dashboard ?expiring= deep-link. */}
              <Select value={expirationFilter} onValueChange={(v) => setExpirationFilter(v as typeof expirationFilter)}>
                <SelectTrigger className="w-full sm:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expiryFilters.map((filter) => (
                    <SelectItem key={filter.value} value={filter.value}>{filter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Columns menu — show/hide + reset. The conventional home for
                  table chrome (keeps the toolbar to data filters); also the
                  discoverable recovery from a dragged-too-far column. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  {/* Labeled (not icon-only) so it's discoverable and distinct from
                      the icon-only Export button beside it. */}
                  <Button variant="outline" size="sm" className="shrink-0" title={t('leases.columns_menu')}>
                    <Columns3 className="h-4 w-4 lg:mr-2" />
                    <span className="hidden lg:inline">{t('leases.columns_menu')}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t('leases.show_columns')}</DropdownMenuLabel>
                  {HIDEABLE_COLUMNS.map((key) => (
                    <DropdownMenuCheckboxItem
                      key={key}
                      checked={colVisible(key)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => setHiddenColumns((h) => toggleHidden(h, key))}
                    >
                      {columnLabel(key)}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={widthsAreDefault && hiddenAtDefault}
                    onClick={() => {
                      resetColumnWidths();
                      // Reset to the DENSITY DEFAULT (start/end/sqft hidden),
                      // not "show everything" — otherwise "reset" produced a
                      // non-default state and the control read as enabled on a
                      // pristine first visit (auditor finding, 2026-07-17).
                      setHiddenColumns([...DEFAULT_HIDDEN_COLUMNS]);
                    }}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t('leases.reset_columns')}
                  </DropdownMenuItem>
                  {/* Announce the auto-fit gesture where users actually look (the
                      divider hover-tooltip alone is undiscoverable). */}
                  <DropdownMenuSeparator />
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('leases.autofit_hint')}</p>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Export — overflow (CSV now; Excel arrives with the library decision). */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label={t('leases.export')} className="shrink-0">
                    <Download className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExportCsv}>{t('leases.export_csv')}</DropdownMenuItem>
                  <DropdownMenuItem disabled>{t('leases.export_excel_soon')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {leases.length === 0 ? (
              // Scoped-empty: the Active/Archived slice is empty but the
              // workspace isn't. The toolbar (incl. the scope Select) stays
              // visible above; offer a one-click path back to everything. #154.
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                {scope === 'archived'
                  ? <Archive className="h-10 w-10 text-muted-foreground" />
                  : <Building2 className="h-10 w-10 text-muted-foreground" />}
                <p className="text-sm text-muted-foreground">
                  {scope === 'archived' ? t('leases.no_archived') : t('leases.no_active')}
                </p>
                <Button variant="outline" onClick={() => setScope('all')}>
                  {t('leases.back_to_all')}
                </Button>
              </div>
            ) : (
            <div className="rounded-lg border border-border bg-card">
              {/* table-fixed REQUIRES every cell to clip — a td is overflow:visible
                  by default, so wide content (a status pill) would paint over its
                  neighbor (the kebab). px-3 (vs px-4) gives ~80px back to content. */}
              <Table
                ref={tableRef}
                className="w-full min-w-[480px] table-fixed [&_td]:overflow-hidden [&_th]:overflow-hidden [&_td]:px-3 [&_th]:px-3"
              >
                <TableHeader>
                  <TableRow>
                    {/* Sortable + resizable headers. Drag the divider on a
                        header's right edge (lg+) to rebalance two columns; the
                        total stays 100% so the table always fits. */}
                    {/* Decorative leading icons removed (they ate the label width in
                        tight columns → icon-only headers); only Property keeps one.
                        Rent + Sq Ft right-align as size numbers. */}
                    {renderSortHead('property', t('leases.property'), Building2, nextResizable('property'))}
                    {colVisible('asset_type') && renderSortHead('asset_type', t('leases.type'), null, nextResizable('asset_type'), 'hidden md:table-cell')}
                    {colVisible('landlord') && renderSortHead('landlord', t('leases.landlord'), null, nextResizable('landlord'), 'hidden md:table-cell')}
                    {renderSortHead('monthly_rent', t('leases.monthly_rent'), null, nextResizable('monthly_rent'), '', 'right')}
                    {colVisible('lease_start') && renderSortHead('lease_start', t('leases.start'), null, nextResizable('lease_start'), 'hidden sm:table-cell')}
                    {colVisible('lease_end') && renderSortHead('lease_end', t('leases.end'), null, nextResizable('lease_end'), 'hidden sm:table-cell')}
                    {colVisible('days_to_expiry') && renderSortHead('days_to_expiry', t('leases.days_to_expiry'), null, nextResizable('days_to_expiry'))}
                    {colVisible('sqft') && renderSortHead('sqft', t('leases.sqft'), null, nextResizable('sqft'), 'hidden lg:table-cell', 'right')}
                    {renderSortHead('status', t('leases.status'), null, nextResizable('status'))}
                    <TableHead style={{ width: `${columnWidths.actions}%` }} className="text-right">
                      <span className="sr-only">{t('leases.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAndSortedLeases.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                        <div className="flex flex-col items-center gap-3">
                          <span>{t('leases.no_match')}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSearchQuery('');
                              setTypeFilter('all');
                              setExpirationFilter('all');
                              setScope('all');
                            }}
                          >
                            {t('leases.clear_filters')}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredAndSortedLeases.map((lease) => {
                      const leaseEnd = getLeaseEnd(lease);
                      const daysUntil = getDaysUntilExpiration(leaseEnd);
                      const monthlyRent = getMonthlyRent(lease);
                      return (
                        <TableRow
                          key={lease.id}
                          className="h-14 cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                          role="link"
                          tabIndex={0}
                          aria-label={t('leases.open_lease', { property: getPropertyAddress(lease) })}
                          onClick={() => navigate(`/app/leases/${lease.id}`)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              navigate(`/app/leases/${lease.id}`);
                            }
                          }}
                        >
                          <TableCell data-col="property" className="font-medium">
                            <span className="block truncate" title={getPropertyAddress(lease)}>{getPropertyAddress(lease)}</span>
                          </TableCell>
                          {colVisible('asset_type') && (
                            <TableCell data-col="asset_type" className="hidden md:table-cell">
                              {lease.asset_type ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Badge variant="outline" className="cursor-default font-normal">
                                      {assetAbbreviation(lease.asset_type, assetAbbr)}
                                    </Badge>
                                  </TooltipTrigger>
                                  <TooltipContent>{prettyAssetType(lease.asset_type)}</TooltipContent>
                                </Tooltip>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                          {colVisible('landlord') && (
                            <TableCell data-col="landlord" className="hidden md:table-cell text-muted-foreground">
                              <span className="block truncate" title={lease.landlord_name || undefined}>{lease.landlord_name || '—'}</span>
                            </TableCell>
                          )}
                          <TableCell
                            data-col="monthly_rent"
                            className="tabular-nums font-medium truncate text-right"
                            title={monthlyRent > 0 ? formatCurrency(monthlyRent) : undefined}
                          >
                            {monthlyRent > 0 ? formatCurrency(monthlyRent) : '—'}
                          </TableCell>
                          {colVisible('lease_start') && (
                            <TableCell data-col="lease_start" className="hidden truncate sm:table-cell text-muted-foreground" title={formatDate(lease.lease_start)}>
                              {formatDate(lease.lease_start)}
                            </TableCell>
                          )}
                          {colVisible('lease_end') && (
                            <TableCell data-col="lease_end" className="hidden truncate sm:table-cell text-muted-foreground" title={formatDate(leaseEnd)}>
                              {formatDate(leaseEnd)}
                            </TableCell>
                          )}
                          {colVisible('days_to_expiry') && (
                            <TableCell data-col="days_to_expiry">
                              {isExpiryRelevant(lease)
                                ? getExpirationBadge(daysUntil)
                                : <span className="text-muted-foreground">&mdash;</span>}
                            </TableCell>
                          )}
                          {colVisible('sqft') && (
                            <TableCell
                              data-col="sqft"
                              className="hidden truncate text-right tabular-nums text-muted-foreground lg:table-cell"
                              title={lease.square_footage ? `${formatLocalizedNumber(lease.square_footage, language)} sq ft` : undefined}
                            >
                              {formatSqFt(lease.square_footage)}
                            </TableCell>
                          )}
                          <TableCell data-col="status">
                            {/* Archived is a terminal display state: it REPLACES the
                                lifecycle badge (showing both "Active" + "Archived" was
                                contradictory). statusSortKey mirrors this exactly. */}
                            {isArchivedDisplay(lease) ? (
                              // Soft/muted pill so the Status column is ONE badge family
                              // (was an outline badge clashing with the soft lifecycle pills).
                              <Badge className="border-0 bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                {t('archive.deleted_badge')}
                              </Badge>
                            ) : (
                              <LeaseStatusBadge status={lease.lifecycle_status || lease.status} appearance="soft" size="sm" />
                            )}
                          </TableCell>
                          <TableCell data-col="actions" className="text-right">
                            {/* Archive/Restore is admin/owner-only (#78 trigger
                                enforces server-side); hidden on read-only Vault
                                workspaces. "Delete permanently" arrives in Phase 3
                                with its soft-delete + 14-day retention backend.
                                Non-admins (and read-only Vault) get a muted chevron
                                so the column isn't empty and the row reads as
                                "click to open". */}
                            {!isReadOnly && isAdmin ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon-sm" aria-label={t('leases.row_actions')}>
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    {lease.archived ? (
                                      <DropdownMenuItem onClick={() => handleRestore(lease)}>
                                        <ArchiveRestore className="mr-2 h-4 w-4" />
                                        {t('archive.unarchive')}
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem onClick={() => handleArchiveClick(lease)}>
                                        <Archive className="mr-2 h-4 w-4" />
                                        {t('archive.archive')}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onClick={() => handleDeleteClick(lease)}
                                      className="text-destructive focus:text-destructive"
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      {t('leases.delete_action')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            ) : (
                              <ChevronRight className="inline-block h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            )}
          </>
        )}
      </PageLayout>

      <AddLeaseDialog
        open={addLeaseDialogOpen}
        onOpenChange={setAddLeaseDialogOpen}
        onRequestApproval={() => setCreateDrawerOpen(true)}
        onUploadDocument={() => setUploadModalOpen(true)}
      />

      <LeaseRequestForm
        open={createDrawerOpen}
        onOpenChange={setCreateDrawerOpen}
        onSuccess={() => fetchLeases()}
      />

      <ArchiveLeaseDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleArchiveConfirm}
        leaseName={getPropertyAddress(selectedLease ?? ({} as LeaseRow)) || selectedLease?.filename || ''}
      />

      <DeleteLeaseWithRetentionDialog
        open={retentionDeleteOpen}
        onOpenChange={(o) => { if (!deletePending) setRetentionDeleteOpen(o); }}
        onConfirm={handleDeleteConfirm}
        leaseName={getPropertyAddress(selectedLease ?? ({} as LeaseRow)) || selectedLease?.filename || ''}
        pending={deletePending}
      />

      <LeaseUploadModal
        open={uploadModalOpen}
        onOpenChange={setUploadModalOpen}
        onSuccess={(leaseId) => { fetchLeases(); navigate(`/app/leases/${leaseId}`); }}
        onQuotaExceeded={() => {
          setUploadModalOpen(false);
          setLimitWallOpen(true);
        }}
      />

      <LimitReachedDialog open={limitWallOpen} onOpenChange={setLimitWallOpen} />
    </AppLayout>
  );
}

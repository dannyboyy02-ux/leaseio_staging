// WorkspaceManagementContent — the "My Workspaces" panel of the
// /app/settings/workspaces drill-down (Owner Workspace Management
// Checkpoint 3; re-homed from the standalone /app/account/workspaces
// page in the 2026-06 Claude-alignment pass — that route now redirects).
//
// Two sections:
//   1. Workspaces I OWN — full management (rename, manage members,
//      delete) for each. The currently-active workspace gets an "Active"
//      pill but is otherwise the same as any other.
//   2. Workspaces I'm a MEMBER of (not owner) — read-only list with
//      "Leave workspace" action.
//
// Member management lives in MembersPanel (extracted in Checkpoint 2).
// We open it in a Sheet so the user can manage members of any workspace
// they own without switching active context.
//
// AppContext is the single source of truth for the workspace inventory
// (loads owned + member workspaces and exposes them as
// availableWorkspaces). We refetch via refreshProfile() after any
// mutation that changes the inventory (rename / delete / leave).

import { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Users,
  FileText,
  Trash2,
  LogOut,
  Loader2,
  Settings,
  Crown,
  Plus,
  ArrowRightLeft,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { MembersPanel } from '@/components/workspace/MembersPanel';
import { RenameWorkspaceInline } from '@/components/workspace/RenameWorkspaceInline';
import { DeleteWorkspaceDialog } from '@/components/workspace/DeleteWorkspaceDialog';
import { NewWorkspaceDialog } from '@/components/workspace/NewWorkspaceDialog';
import { TransferOwnershipDialog } from '@/components/workspace/TransferOwnershipDialog';

interface WorkspaceMeta {
  id: string;
  name: string;
  owner_id: string;
  plan: string | null;
  created_at: string;
  /** Accepted members, owner-inclusive (the owner may have no member row
   *  on workspaces created via the create-workspace edge function). */
  member_count: number;
  /** Invited-but-unaccepted workspace_members rows. */
  pending_invite_count: number;
  lease_count: number;
}

export function WorkspaceManagementContent() {
  const { user, workspace: activeWorkspace, availableWorkspaces, refreshProfile, switchWorkspace } = useApp();
  const { t } = useAppTranslation();
  const queryClient = useQueryClient();

  const [manageMembersWorkspaceId, setManageMembersWorkspaceId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<WorkspaceMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMeta | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Phase 2: create-new-workspace affordance. Always rendered — the dialog
  // surfaces the right gate (upgrade prompt / cap_reached / no_card) based on
  // the server preview, so a Starter user sees a clear path forward instead
  // of an empty page.
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);

  // Split availableWorkspaces by ownership (we have role per row already).
  const ownedIds = useMemo(
    () => availableWorkspaces.filter((w) => w.role === 'owner').map((w) => w.id),
    [availableWorkspaces],
  );
  const memberOnly = useMemo(
    () => availableWorkspaces.filter((w) => w.role !== 'owner'),
    [availableWorkspaces],
  );

  // Hydrate per-workspace metadata (member + lease counts, full row).
  // This is the only point where we go to the DB beyond what AppContext
  // already loaded; it's small (one query per visible workspace, plus
  // two count queries each) and only fires for workspaces the current
  // user can see (RLS-enforced).
  const { data: ownedMeta = [], isLoading: ownedLoading } = useQuery({
    queryKey: ['account-owned-workspaces', user?.id, ownedIds.join(',')],
    enabled: !!user?.id && ownedIds.length > 0,
    queryFn: async (): Promise<WorkspaceMeta[]> => {
      const { data: rows } = await supabase
        .from('workspaces')
        .select('id, name, owner_id, plan, created_at')
        .in('id', ownedIds);
      const base = (rows ?? []) as Array<Omit<WorkspaceMeta, 'member_count' | 'lease_count'>>;
      // Fetch counts per workspace (could be batched into a single RPC
      // later; for v1 keep it simple).
      const enriched = await Promise.all(
        base.map(async (w) => {
          const [{ data: memberRows }, { count: leaseCount }] = await Promise.all([
            supabase
              .from('workspace_members')
              .select('user_id, accepted_at')
              .eq('workspace_id', w.id),
            supabase
              .from('leases')
              .select('id', { count: 'exact', head: true })
              .eq('workspace_id', w.id),
          ]);
          // Count accepted members only — pending invites previously
          // inflated the member count on this audit-minded surface. The
          // owner is counted even without a member row (create-workspace
          // workspaces don't give them one).
          const rows = memberRows ?? [];
          const accepted = rows.filter((r) => r.accepted_at !== null);
          const ownerHasRow = accepted.some((r) => r.user_id === w.owner_id);
          return {
            ...w,
            name: w.name ?? 'Unnamed workspace',
            member_count: accepted.length + (ownerHasRow ? 0 : 1),
            pending_invite_count: rows.length - accepted.length,
            lease_count: leaseCount ?? 0,
          };
        }),
      );
      return enriched.sort((a, b) =>
        a.created_at.localeCompare(b.created_at),
      );
    },
  });

  // ownedIds is derived synchronously from AppContext — using ownedMeta
  // (async query, starts []) here caused a list→grid layout jump on load.
  const useGridLayout = ownedIds.length + memberOnly.length > 5;

  // Reset manage-members sheet if the workspace we were managing is gone.
  useEffect(() => {
    if (manageMembersWorkspaceId && !ownedIds.includes(manageMembersWorkspaceId)) {
      setManageMembersWorkspaceId(null);
    }
  }, [manageMembersWorkspaceId, ownedIds]);

  const manageMembersWorkspace = manageMembersWorkspaceId
    ? ownedMeta.find((w) => w.id === manageMembersWorkspaceId) ?? null
    : null;

  // ── Mutations ────────────────────────────────────────────────────────

  const handleLeaveWorkspace = async () => {
    if (!leaveTarget || !user?.id) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from('workspace_members')
        .delete()
        .eq('workspace_id', leaveTarget.id)
        .eq('user_id', user.id);
      if (error) throw error;
      toast.success(`Left "${leaveTarget.name}"`);
      setLeaveTarget(null);
      // If we just left the active workspace, switch to a fallback.
      if (activeWorkspace?.id === leaveTarget.id) {
        const fallback = availableWorkspaces.find((w) => w.id !== leaveTarget.id);
        if (fallback) await switchWorkspace(fallback.id);
      }
      await refreshProfile();
      queryClient.invalidateQueries({ queryKey: ['account-owned-workspaces'] });
    } catch (err: any) {
      console.error('leave workspace error:', err);
      // Raw DB/RLS error strings read like stack traces to a finance user —
      // log the real error, show a human one.
      toast.error("Couldn't leave this workspace — please try again or contact support.");
    } finally {
      setBusy(false);
    }
  };

  const handleAfterTransfer = async () => {
    // The workspace moves from "owned" to "member of" — the prior owner
    // stays an admin member, so no active-workspace fallback is needed.
    setTransferTarget(null);
    await refreshProfile();
    queryClient.invalidateQueries({ queryKey: ['account-owned-workspaces'] });
  };

  const handleAfterDelete = async () => {
    // If we deleted the active workspace, pick a fallback before
    // refreshing — refreshProfile will land on a fresh workspace cleanly.
    if (deleteTarget && activeWorkspace?.id === deleteTarget.id) {
      const fallback = availableWorkspaces.find((w) => w.id !== deleteTarget.id);
      if (fallback) await switchWorkspace(fallback.id);
    }
    setDeleteTarget(null);
    await refreshProfile();
    queryClient.invalidateQueries({ queryKey: ['account-owned-workspaces'] });
  };

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <>
      <div className="max-w-5xl space-y-8">
        {/* Owned workspaces */}
        <section>
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Crown className="h-4 w-4 text-amber-500" />
                Workspaces you own
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Full management — rename, manage members, delete.
              </p>
            </div>
            <Button onClick={() => setNewWorkspaceOpen(true)} className="shrink-0">
              <Plus className="h-4 w-4 mr-1.5" />
              {t('workspace.create.cta')}
            </Button>
          </div>

          {ownedLoading && ownedIds.length > 0 ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          ) : ownedMeta.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center space-y-3">
                <p className="text-muted-foreground">
                  You don't own any workspaces yet. A workspace is where your team's
                  leases, approvals, and settings live.
                </p>
                <Button onClick={() => setNewWorkspaceOpen(true)}>
                  <Plus className="h-4 w-4 mr-1.5" />
                  Create your first workspace
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className={useGridLayout ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4' : 'space-y-3'}>
              {ownedMeta.map((ws) => {
                const isActive = activeWorkspace?.id === ws.id;
                return (
                  <Card key={ws.id}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <CardTitle className="text-base font-semibold flex items-center gap-2 flex-wrap">
                            <RenameWorkspaceInline
                              workspaceId={ws.id}
                              currentName={ws.name}
                              onRenamed={async () => {
                                await refreshProfile();
                                queryClient.invalidateQueries({
                                  queryKey: ['account-owned-workspaces'],
                                });
                              }}
                            />
                            {isActive && (
                              <Badge variant="default" className="text-[10px] px-1.5">
                                Active
                              </Badge>
                            )}
                            {ws.plan && (
                              <Badge variant="outline" className="text-[10px] px-1.5 capitalize">
                                {ws.plan}
                              </Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                            <span className="inline-flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {ws.member_count} member{ws.member_count === 1 ? '' : 's'}
                              {ws.pending_invite_count > 0 &&
                                ` · ${ws.pending_invite_count} pending`}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <FileText className="h-3 w-3" />
                              {ws.lease_count} lease{ws.lease_count === 1 ? '' : 's'}
                            </span>
                            <span>Created {format(new Date(ws.created_at), 'MMM d, yyyy')}</span>
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setManageMembersWorkspaceId(ws.id)}
                      >
                        <Users className="h-3.5 w-3.5 mr-1.5" />
                        Manage members
                      </Button>
                      {!isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => switchWorkspace(ws.id)}
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                          Switch to
                        </Button>
                      )}
                      {isActive && (
                        <Button size="sm" variant="ghost" asChild>
                          <Link to="/app/settings/workspaces/profile">
                            <Settings className="h-3.5 w-3.5 mr-1.5" />
                            Settings
                          </Link>
                        </Button>
                      )}
                      {/* Always rendered: gating on member counts hid the
                          capability from solo owners, and the dialog's
                          invite-first empty state teaches the path. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setTransferTarget(ws)}
                      >
                        <Crown className="h-3.5 w-3.5 mr-1.5" />
                        {t('workspace.transfer.cta')}
                      </Button>
                      {useGridLayout ? (
                        // Narrow grid cards wrap the action row, which would
                        // land Delete flush against Transfer — keep the
                        // destructive action visually isolated on its own row.
                        <div className="basis-full flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(ws)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                            Delete
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex-1" />
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            onClick={() => setDeleteTarget(ws)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                            Delete
                          </Button>
                        </>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        {/* Member-of workspaces */}
        {memberOnly.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Workspaces you belong to
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              You have member access. Leave a workspace to lose access immediately.
            </p>
            <div className="space-y-3">
              {memberOnly.map((ws) => {
                const isActive = activeWorkspace?.id === ws.id;
                return (
                  <Card key={ws.id}>
                    <CardContent className="py-4 flex items-center justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold truncate">{ws.name}</span>
                          {isActive && (
                            <Badge variant="default" className="text-[10px] px-1.5">
                              Active
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px] px-1.5 capitalize">
                            {ws.role}
                          </Badge>
                          {ws.plan && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 capitalize">
                              {ws.plan}
                            </Badge>
                          )}
                        </div>
                        {/* A just-demoted prior owner lands here with the
                            section's "member access" framing — remind admins
                            they still manage members via Workspace Settings. */}
                        {ws.role === 'admin' && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('workspace.transfer.admin_member_hint')}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {!isActive && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => switchWorkspace(ws.id)}
                          >
                            {/* ArrowRightLeft, not ExternalLink — this switches the
                                in-app active workspace, it doesn't open a new tab. */}
                            <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                            Switch to
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setLeaveTarget({ id: ws.id, name: ws.name })}
                        >
                          <LogOut className="h-3.5 w-3.5 mr-1.5" />
                          Leave
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* Manage Members sheet — workspace-agnostic via MembersPanel prop */}
      <Sheet
        open={manageMembersWorkspace !== null}
        onOpenChange={(o) => !o && setManageMembersWorkspaceId(null)}
      >
        <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
          {manageMembersWorkspace && (
            <>
              <SheetHeader>
                <SheetTitle>Members — {manageMembersWorkspace.name}</SheetTitle>
                <SheetDescription>
                  Invite, change roles, or remove members. Changes apply to this workspace only.
                </SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                <MembersPanel
                  workspaceId={manageMembersWorkspace.id}
                  ownerId={manageMembersWorkspace.owner_id}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Phase 2 — Create new workspace */}
      <NewWorkspaceDialog
        open={newWorkspaceOpen}
        onOpenChange={setNewWorkspaceOpen}
      />

      {/* Phase 3 — Transfer ownership */}
      {transferTarget && (
        <TransferOwnershipDialog
          open={transferTarget !== null}
          onOpenChange={(o) => !o && setTransferTarget(null)}
          workspaceId={transferTarget.id}
          workspaceName={transferTarget.name}
          ownerId={transferTarget.owner_id}
          onTransferred={handleAfterTransfer}
          onManageMembers={() => setManageMembersWorkspaceId(transferTarget.id)}
        />
      )}

      {/* Delete dialog — type-name confirmation */}
      {deleteTarget && (
        <DeleteWorkspaceDialog
          open={deleteTarget !== null}
          onOpenChange={(o) => !o && setDeleteTarget(null)}
          workspaceId={deleteTarget.id}
          workspaceName={deleteTarget.name}
          leaseCount={deleteTarget.lease_count}
          memberCount={deleteTarget.member_count}
          isOnlyWorkspace={
            availableWorkspaces.filter((w) => w.id !== deleteTarget.id).length === 0
          }
          onDeleted={handleAfterDelete}
        />
      )}

      {/* Leave-workspace confirmation */}
      <AlertDialog
        open={leaveTarget !== null}
        onOpenChange={(o) => !o && !busy && setLeaveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              You'll lose access to <strong>{leaveTarget?.name}</strong> immediately.
              The workspace owner will need to invite you again to restore access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleLeaveWorkspace();
              }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Leave workspace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

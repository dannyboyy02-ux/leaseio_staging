import { useState } from 'react';
import { roleLabel, stageLabel } from '@/lib/lifecycleStates';
import { Loader2, AlertTriangle, CheckCircle2, XCircle, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { buildAssetTypeOptions, type AssetTypeOption } from '@/lib/assetTypes';

// Built-in asset-type options; the workspace's configured Asset Types are
// merged in by the caller via `assetTypeOptions`. The matcher canonicalizes
// both sides (preview_policy_resolution → canonical_asset_type), so a custom
// label stored by LeaseReview still resolves against a 'property' rule.
const DEFAULT_ASSET_TYPE_OPTIONS: AssetTypeOption[] = buildAssetTypeOptions();

const LEASE_TYPE_OPTIONS: string[] = ['Real Estate', 'Equipment'];

// Radix Select can't use an empty-string value, so "Any" (no filter) uses a
// sentinel that we map back to '' before calling the RPC. Without this there's
// no way back to "Any" once a value is picked short of closing the dialog.
const ANY = '__any';

type ResolutionResult =
  | {
      matched: true;
      policy_id: string;
      policy_name: string;
      policy_priority: number;
      policy_version: number;
      separation_override: boolean | null;
      chain: Array<{
        stage: 'concept' | 'signator';
        step_order: number;
        parallel_group: number;
        approver_user_id: string | null;
        approver_role: string | null;
        delegate_user_id: string | null;
        is_required: boolean;
      }>;
      warnings: string[];
    }
  | { matched: false; error: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** Workspace-resolved asset-type options (built-ins + configured Asset
   *  Types). Falls back to the built-ins when the caller doesn't pass them. */
  assetTypeOptions?: AssetTypeOption[];
}

export function ApprovalPolicyTestDialog({
  open,
  onOpenChange,
  workspaceId,
  assetTypeOptions = DEFAULT_ASSET_TYPE_OPTIONS,
}: Props) {
  const [assetType, setAssetType] = useState<string>('');
  const [leaseType, setLeaseType] = useState<string>('');
  const [department, setDepartment] = useState<string>('');
  const [region, setRegion] = useState<string>('');
  const [annualCost, setAnnualCost] = useState<string>('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ResolutionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const reset = () => {
    setAssetType('');
    setLeaseType('');
    setDepartment('');
    setRegion('');
    setAnnualCost('');
    setResult(null);
    setErrorMsg(null);
  };

  const run = async () => {
    if (!workspaceId) return;
    setRunning(true);
    setErrorMsg(null);
    setResult(null);
    try {
      const annualNum = annualCost.trim() === '' ? 0 : parseFloat(annualCost);
      if (annualCost.trim() !== '' && !Number.isFinite(annualNum)) {
        throw new Error('Annual cost must be a number.');
      }
      const { data, error } = await supabase.rpc('preview_policy_resolution', {
        p_workspace_id: workspaceId,
        p_asset_type: assetType || '',
        p_department: department || '',
        p_annual_cost: annualNum,
        p_region: region || '',
        p_lease_type: leaseType || '',
      });
      if (error) throw error;
      setResult(data as unknown as ResolutionResult);
    } catch (err: any) {
      setErrorMsg(err?.message ?? 'Failed to run resolution');
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle>Test policy resolution</DialogTitle>
          <DialogDescription>
            Simulate what would happen if a request with these attributes were submitted right now. This is read-only —
            no policies or chains are created.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 overflow-y-auto flex-1 space-y-5">
          {/* Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Asset type</Label>
              <Select
                value={assetType || ANY}
                onValueChange={(v) => setAssetType(v === ANY ? '' : v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any</SelectItem>
                  {assetTypeOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Lease type</Label>
              <Select
                value={leaseType || ANY}
                onValueChange={(v) => setLeaseType(v === ANY ? '' : v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>Any</SelectItem>
                  {LEASE_TYPE_OPTIONS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Department</Label>
              <Input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="e.g. Operations"
                className="h-9"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Region</Label>
              <Input
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="e.g. West"
                className="h-9"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs">Estimated annual cost (USD)</Label>
              <Input
                type="number"
                value={annualCost}
                onChange={(e) => setAnnualCost(e.target.value)}
                placeholder="0"
                className="h-9"
                inputMode="decimal"
              />
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {errorMsg}
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-3">
              <div className="border-t pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Result</p>

                {result.matched === false ? (
                  <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-destructive">No policy matched</p>
                      <p className="text-xs text-muted-foreground mt-1">{result.error}</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="rounded-md border bg-muted/30 px-3 py-2 mb-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <p className="text-sm font-medium">{result.policy_name}</p>
                        <Badge variant="outline" className="text-xs">priority {result.policy_priority}</Badge>
                        <Badge variant="outline" className="text-xs">version {result.policy_version}</Badge>
                      </div>
                      {result.warnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {result.warnings.map((w) => (
                            <div key={w} className="flex items-start gap-1.5 text-xs text-amber-700">
                              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                              <span>{w}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Chain — separated by stage */}
                    {(['concept', 'signator'] as const).map((stage) => {
                      const stageSteps = result.chain.filter((s) => s.stage === stage);
                      return (
                        <div key={stage}>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                            {stageLabel(stage)}
                          </p>
                          {stageSteps.length === 0 ? (
                            <p className="text-xs text-muted-foreground italic px-3 py-2">No steps configured.</p>
                          ) : (
                            <div className="space-y-1.5">
                              {stageSteps.map((s, i) => (
                                <div
                                  key={`${stage}-${i}`}
                                  className="rounded-md border px-3 py-2 flex items-center gap-3"
                                >
                                  <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                                  <div className="min-w-0 flex-1 text-xs">
                                    <span className="font-medium">Step {s.step_order}</span>
                                    {s.parallel_group !== 1 && (
                                      <span className="text-muted-foreground"> · group {s.parallel_group}</span>
                                    )}
                                    <span className="text-muted-foreground"> · </span>
                                    <span>
                                      {s.approver_user_id
                                        ? `User ${s.approver_user_id.slice(0, 8)}…`
                                        : `Role: ${roleLabel(s.approver_role)}`}
                                    </span>
                                    {s.delegate_user_id && (
                                      <span className="text-muted-foreground">
                                        {' '}· delegate {s.delegate_user_id.slice(0, 8)}…
                                      </span>
                                    )}
                                  </div>
                                  {s.is_required ? (
                                    <Badge variant="outline" className="text-[10px]">required</Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-[10px]">optional</Badge>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    <div className="text-xs text-muted-foreground pt-1">
                      Separation of duties:{' '}
                      <strong>
                        {result.separation_override == null
                          ? 'Inherits workspace default'
                          : result.separation_override
                          ? 'Require distinct users'
                          : 'Allow same user in multiple roles'}
                      </strong>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0">
          <Button
            variant="ghost"
            onClick={() => {
              // Match the X / Escape / backdrop paths (onOpenChange wrapper
              // resets on close) so reopening never shows a stale result.
              reset();
              onOpenChange(false);
            }}
          >
            Close
          </Button>
          <Button onClick={run} disabled={running || !workspaceId}>
            {running ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                Resolving…
              </>
            ) : (
              'Run resolution'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

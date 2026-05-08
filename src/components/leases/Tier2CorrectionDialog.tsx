// Tier2CorrectionDialog — Phase 4 of the Tier 2 build.
//
// Modal that lets a workspace member submit a correction to the
// AI classifier's output. Posts to the record-classification-correction
// edge function which appends to classification_corrections.
//
// The next time process_lease runs Tier 2 for this workspace, the
// recent corrections (top 10 most recent) get injected as few-shot
// examples in the Haiku system prompt — so the classifier learns
// this team's specific document patterns over time.

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

type CorrectionType =
  | 'is_lease_override'
  | 'asset_type_changed'
  | 'lease_type_changed'
  | 'parent_lease_changed'
  | 'general_correction';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  leaseId: string | null;
  // The full original Tier 2 classification object stored on
  // extracted_json._tier2_classification. Sent verbatim so the
  // server has the full original context.
  originalClassification: Record<string, unknown> | null;
  // Optional document summary for prompt context. Filename + a
  // few extracted fields. Stays inside the workspace.
  documentSummary?: string | null;
}

const CORRECTION_TYPE_OPTIONS: Array<{ value: CorrectionType; label: string; description: string }> = [
  {
    value: 'asset_type_changed',
    label: 'Wrong asset type',
    description: 'The classifier called this real estate / equipment / vehicle, but it should be a different type.',
  },
  {
    value: 'lease_type_changed',
    label: 'Wrong lease type (master vs amendment)',
    description: 'The classifier called this a master lease but it is an amendment, or vice versa.',
  },
  {
    value: 'is_lease_override',
    label: 'It IS a lease (we said no)',
    description: 'The classifier rejected this as not-a-lease, but it actually is one.',
  },
  {
    value: 'parent_lease_changed',
    label: 'Wrong parent lease',
    description: 'The suggested parent lease was wrong; the real parent is different.',
  },
  {
    value: 'general_correction',
    label: 'Other classification error',
    description: 'A correction that doesn\'t fit the categories above.',
  },
];

export function Tier2CorrectionDialog({
  open,
  onOpenChange,
  workspaceId,
  leaseId,
  originalClassification,
  documentSummary,
}: Props) {
  const [correctionType, setCorrectionType] = useState<CorrectionType>('asset_type_changed');
  const [correctedAssetType, setCorrectedAssetType] = useState<string>('');
  const [correctedLeaseType, setCorrectedLeaseType] = useState<string>('');
  const [correctedIsLease, setCorrectedIsLease] = useState<boolean>(true);
  const [userNote, setUserNote] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCorrectionType('asset_type_changed');
    setCorrectedAssetType('');
    setCorrectedLeaseType('');
    setCorrectedIsLease(true);
    setUserNote('');
  };

  const handleSubmit = async () => {
    if (!workspaceId) {
      toast.error('Workspace not loaded');
      return;
    }

    // Build the corrected classification — only fields the user is
    // explicitly correcting. The server keeps the full original for
    // forensics; the corrected payload is the delta.
    const correctedClassification: Record<string, unknown> = {};
    if (correctionType === 'is_lease_override') {
      correctedClassification.is_lease = correctedIsLease;
    } else if (correctionType === 'asset_type_changed') {
      if (!correctedAssetType) {
        toast.error('Please select the correct asset type');
        return;
      }
      correctedClassification.asset_type = correctedAssetType;
    } else if (correctionType === 'lease_type_changed') {
      if (!correctedLeaseType) {
        toast.error('Please select the correct lease type');
        return;
      }
      correctedClassification.lease_type = correctedLeaseType;
    } else {
      // general_correction / parent_lease_changed — rely on user_note for the signal
      if (!userNote.trim()) {
        toast.error('Please describe the correction in the notes field');
        return;
      }
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'record-classification-correction',
        {
          body: {
            workspaceId,
            leaseId,
            originalClassification: originalClassification ?? {},
            correctedClassification,
            correctionType,
            userNote: userNote.trim() || null,
            documentSummary: documentSummary ?? null,
          },
        },
      );
      if (error) throw error;
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? 'Correction failed');

      toast.success('Correction recorded — the AI will use this to improve future classifications for your workspace');
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error('[Tier2CorrectionDialog] submit failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to record correction');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Submit a correction</DialogTitle>
          <DialogDescription>
            Help your workspace's AI classifier learn. Recent corrections from your team are used as guidance for similar documents going forward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="correction-type">What was wrong?</Label>
            <Select value={correctionType} onValueChange={(v) => setCorrectionType(v as CorrectionType)}>
              <SelectTrigger id="correction-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CORRECTION_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {CORRECTION_TYPE_OPTIONS.find((o) => o.value === correctionType)?.description}
            </p>
          </div>

          {correctionType === 'asset_type_changed' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-asset-type">Correct asset type</Label>
              <Select value={correctedAssetType} onValueChange={setCorrectedAssetType}>
                <SelectTrigger id="corrected-asset-type">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="real_estate">Real estate</SelectItem>
                  <SelectItem value="equipment">Equipment</SelectItem>
                  <SelectItem value="vehicle">Vehicle</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {correctionType === 'lease_type_changed' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-lease-type">Correct lease type</Label>
              <Select value={correctedLeaseType} onValueChange={setCorrectedLeaseType}>
                <SelectTrigger id="corrected-lease-type">
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="master">Master lease</SelectItem>
                  <SelectItem value="amendment">Amendment</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {correctionType === 'is_lease_override' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-is-lease">Is this a lease?</Label>
              <Select
                value={correctedIsLease ? 'yes' : 'no'}
                onValueChange={(v) => setCorrectedIsLease(v === 'yes')}
              >
                <SelectTrigger id="corrected-is-lease">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes — this is a lease</SelectItem>
                  <SelectItem value="no">No — confirming it isn't a lease</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="user-note">
              Notes <span className="text-muted-foreground">(optional, but helpful)</span>
            </Label>
            <Textarea
              id="user-note"
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder="Why was this wrong? Any context you'd want a colleague to know."
              rows={3}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">
              The AI uses your notes as guidance for similar documents. Stays in your workspace.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

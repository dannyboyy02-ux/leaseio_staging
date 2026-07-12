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
import { useAppTranslation } from '@/hooks/useAppTranslation';

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

const CORRECTION_TYPE_OPTIONS: Array<{ value: CorrectionType; labelKey: string; descriptionKey: string }> = [
  {
    value: 'asset_type_changed',
    labelKey: 'leases.tier2.type_asset_label',
    descriptionKey: 'leases.tier2.type_asset_desc',
  },
  {
    value: 'lease_type_changed',
    labelKey: 'leases.tier2.type_lease_label',
    descriptionKey: 'leases.tier2.type_lease_desc',
  },
  {
    value: 'is_lease_override',
    labelKey: 'leases.tier2.type_is_lease_label',
    descriptionKey: 'leases.tier2.type_is_lease_desc',
  },
  {
    value: 'parent_lease_changed',
    labelKey: 'leases.tier2.type_parent_label',
    descriptionKey: 'leases.tier2.type_parent_desc',
  },
  {
    value: 'general_correction',
    labelKey: 'leases.tier2.type_general_label',
    descriptionKey: 'leases.tier2.type_general_desc',
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
  const { t } = useAppTranslation();
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
      toast.error(t('leases.tier2.workspace_not_loaded'));
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
        toast.error(t('leases.tier2.select_asset_error'));
        return;
      }
      correctedClassification.asset_type = correctedAssetType;
    } else if (correctionType === 'lease_type_changed') {
      if (!correctedLeaseType) {
        toast.error(t('leases.tier2.select_lease_error'));
        return;
      }
      correctedClassification.lease_type = correctedLeaseType;
    } else {
      // general_correction / parent_lease_changed — rely on user_note for the signal
      if (!userNote.trim()) {
        toast.error(t('leases.tier2.describe_error'));
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
      if ((data as any)?.ok === false) throw new Error((data as any)?.error ?? t('leases.tier2.correction_failed'));

      toast.success(t('leases.tier2.success'));
      reset();
      onOpenChange(false);
    } catch (err) {
      console.error('[Tier2CorrectionDialog] submit failed:', err);
      toast.error(err instanceof Error ? err.message : t('leases.tier2.record_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('leases.tier2.title')}</DialogTitle>
          <DialogDescription>
            {t('leases.tier2.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="correction-type">{t('leases.tier2.what_wrong')}</Label>
            <Select value={correctionType} onValueChange={(v) => setCorrectionType(v as CorrectionType)}>
              <SelectTrigger id="correction-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CORRECTION_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t(CORRECTION_TYPE_OPTIONS.find((o) => o.value === correctionType)?.descriptionKey ?? '')}
            </p>
          </div>

          {correctionType === 'asset_type_changed' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-asset-type">{t('leases.tier2.correct_asset_type')}</Label>
              <Select value={correctedAssetType} onValueChange={setCorrectedAssetType}>
                <SelectTrigger id="corrected-asset-type">
                  <SelectValue placeholder={t('leases.tier2.select_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="real_estate">{t('leases.tier2.asset_real_estate')}</SelectItem>
                  <SelectItem value="equipment">{t('leases.tier2.asset_equipment')}</SelectItem>
                  <SelectItem value="vehicle">{t('leases.tier2.asset_vehicle')}</SelectItem>
                  <SelectItem value="other">{t('leases.tier2.asset_other')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {correctionType === 'lease_type_changed' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-lease-type">{t('leases.tier2.correct_lease_type')}</Label>
              <Select value={correctedLeaseType} onValueChange={setCorrectedLeaseType}>
                <SelectTrigger id="corrected-lease-type">
                  <SelectValue placeholder={t('leases.tier2.select_placeholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="master">{t('leases.tier2.master_lease')}</SelectItem>
                  <SelectItem value="amendment">{t('leases.tier2.amendment')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {correctionType === 'is_lease_override' && (
            <div className="space-y-2">
              <Label htmlFor="corrected-is-lease">{t('leases.tier2.is_this_lease')}</Label>
              <Select
                value={correctedIsLease ? 'yes' : 'no'}
                onValueChange={(v) => setCorrectedIsLease(v === 'yes')}
              >
                <SelectTrigger id="corrected-is-lease">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">{t('leases.tier2.yes_lease')}</SelectItem>
                  <SelectItem value="no">{t('leases.tier2.no_lease')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="user-note">
              {t('leases.tier2.notes_label')} <span className="text-muted-foreground">{t('leases.tier2.notes_optional')}</span>
            </Label>
            <Textarea
              id="user-note"
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder={t('leases.tier2.notes_placeholder')}
              rows={3}
              maxLength={1000}
            />
            <p className="text-xs text-muted-foreground">
              {t('leases.tier2.notes_help')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('leases.tier2.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

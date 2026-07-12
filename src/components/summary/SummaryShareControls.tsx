import { useState, useEffect } from 'react';
import { Copy, Check, Share2, Eye, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { useAppTranslation } from '@/hooks/useAppTranslation';

interface Props {
  leaseId: string;
  lifecycleStatus: string;
}

// Phase 3 (KNOWN_ISSUES.md item #7): extended in place to cover the chain
// vocabulary equivalents of the post-approval / executed groups.
// Consolidation to a STATE_GROUPS-derived helper is filed for a future
// refactor.
const SHAREABLE_STATUSES = new Set([
  // Legacy
  'approved', 'executed', 'active',
  // Chain
  'in_negotiation', 'final_review', 'pending_counter_signature', 'fully_executed',
]);

export function SummaryShareControls({ leaseId, lifecycleStatus }: Props) {
  const { t } = useAppTranslation();
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [viewCount, setViewCount] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const canShare = SHAREABLE_STATUSES.has(lifecycleStatus);

  // On mount: check if token already exists
  useEffect(() => {
    if (!canShare) return;
    (supabase as any)
      .from('leases')
      .select('summary_share_token, summary_shared_at, summary_share_token_expires_at')
      .eq('id', leaseId)
      .single()
      .then(async ({ data }: { data: any }) => {
        if (data?.summary_share_token) {
          // Treat already-expired tokens as no-link to avoid surfacing dead URLs.
          const expiry = data.summary_share_token_expires_at as string | null;
          if (expiry && new Date(expiry).getTime() <= Date.now()) {
            return;
          }
          const url = `${window.location.origin}/share/${data.summary_share_token}`;
          setShareUrl(url);
          setGeneratedAt(data.summary_shared_at);
          setExpiresAt(expiry);
          // Get view count
          const { count } = await (supabase as any)
            .from('summary_views')
            .select('id', { count: 'exact', head: true })
            .eq('lease_id', leaseId);
          setViewCount(count || 0);
        }
      });
  }, [leaseId, canShare]);

  if (!canShare) return null;

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-summary-token', {
        body: { lease_id: leaseId },
      });
      if (error) throw error;
      setShareUrl(data.url);
      setGeneratedAt(data.generated_at);
      setExpiresAt(data.expires_at ?? null);
      setViewCount(data.view_count || 0);
    } catch (err: any) {
      toast.error(t('workflow.share.generate_failed'));
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async () => {
    if (!confirm(t('workflow.share.revoke_confirm'))) return;
    setRevoking(true);
    try {
      const { error } = await supabase.functions.invoke('generate-summary-token', {
        body: { lease_id: leaseId, action: 'revoke' },
      });
      if (error) throw error;
      setShareUrl(null);
      setGeneratedAt(null);
      setExpiresAt(null);
      setViewCount(0);
      toast.success(t('workflow.share.revoked'));
    } catch (err: any) {
      toast.error(t('workflow.share.revoke_failed'));
      console.error(err);
    } finally {
      setRevoking(false);
    }
  };

  const handleCopy = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast.success(t('workflow.share.copied'));
  };

  return (
    <div className="rounded-lg border bg-background p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Share2 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t('workflow.share.title')}</span>
        <span className="text-xs text-muted-foreground ml-1">
          {t('workflow.share.subtitle')}
        </span>
      </div>

      {!shareUrl ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={loading}
          className="w-full"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Share2 className="h-4 w-4 mr-2" />
          )}
          {t('workflow.share.generate')}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 rounded-md border border-input bg-muted px-3 py-1.5 text-xs font-mono text-muted-foreground truncate min-w-0"
            />
            <Button size="sm" variant="outline" onClick={handleCopy} className="shrink-0 w-9 px-0">
              {copied ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRevoke}
              disabled={revoking}
              className="shrink-0 w-9 px-0"
              title={t('workflow.share.revoke_title')}
            >
              {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-3">
              {generatedAt && (
                <span>
                  {t('workflow.share.generated', { date: format(new Date(generatedAt), 'MMM d, yyyy') })}
                </span>
              )}
              {expiresAt && (
                <span>
                  {t('workflow.share.expires_in', { duration: formatDistanceToNowStrict(new Date(expiresAt)) })}
                </span>
              )}
            </span>
            {viewCount > 0 && (
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {t('workflow.share.viewed', { count: viewCount })}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

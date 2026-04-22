import { useState, useCallback } from 'react';
import { pdf } from '@react-pdf/renderer';
import { Download, FileText, Lock, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { LeaseAnalysisDocument } from '@/components/leases/LeaseAnalysisExport';
import { type ReportLease, type ReportProse } from '@/lib/reportGeneration';

interface LeaseDocumentsTabProps {
  leaseId: string;
  filename: string | null;
  storagePath: string | null;
  executedFilename?: string | null;
  executedStoragePath?: string | null;
}

function formatNow(): string {
  return new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function LeaseDocumentsTab({
  leaseId,
  filename,
  storagePath,
  executedFilename,
  executedStoragePath,
}: LeaseDocumentsTabProps) {
  const { canAccessFeature } = useApp();
  const isBusinessPlan = canAccessFeature('business');
  const [generatingPdf, setGeneratingPdf] = useState(false);

  const handleDownload = useCallback(async (path: string, displayName: string, bucket: string) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      toast.error('Could not generate download link');
      return;
    }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = displayName;
    a.target = '_blank';
    a.click();
  }, []);

  const handleGenerateAnalysis = useCallback(async () => {
    setGeneratingPdf(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-lease-analysis`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ leaseId }),
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Analysis generation failed' }));
        throw new Error(err.error || 'Analysis generation failed');
      }

      const result = await res.json();
      const lease = result.lease as ReportLease;
      const prose = result.prose as ReportProse;
      const generatedAt = formatNow();

      const blob = await pdf(
        <LeaseAnalysisDocument lease={lease} prose={prose} generatedAt={generatedAt} />
      ).toBlob();

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${lease.display_name || 'lease'} - Analysis Report.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Analysis report downloaded');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate analysis';
      toast.error(message);
    } finally {
      setGeneratingPdf(false);
    }
  }, [leaseId]);

  return (
    <Card className="shadow-none border overflow-hidden">
      <CardHeader className="bg-muted/30 border-b py-3">
        <CardTitle className="text-sm font-bold">Documents</CardTitle>
        <CardDescription className="text-xs">
          Original files and AI-generated analysis for this lease
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 space-y-2">
        {/* Original lease PDF */}
        {storagePath && filename && (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{filename}</p>
                <p className="text-xs text-muted-foreground">Original lease</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => handleDownload(storagePath, filename, 'leases')}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        )}

        {/* Executed copy */}
        {executedStoragePath && executedFilename && (
          <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-green-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{executedFilename}</p>
                <p className="text-xs text-muted-foreground">Executed copy</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              onClick={() => handleDownload(executedStoragePath, executedFilename, 'executed-leases')}
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Download
            </Button>
          </div>
        )}

        {/* Analysis PDF — Business tier only */}
        <div className="flex items-center justify-between rounded-md border px-3 py-2.5 gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="h-4 w-4 text-blue-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Lease Analysis Report</p>
              <p className="text-xs text-muted-foreground">AI-generated 1–2 page summary</p>
            </div>
          </div>
          {isBusinessPlan ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={generatingPdf}
              onClick={handleGenerateAnalysis}
            >
              {generatingPdf ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5 mr-1.5" />
                  Generate
                </>
              )}
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="outline" className="shrink-0 opacity-50" disabled>
                    <Lock className="h-3.5 w-3.5 mr-1.5" />
                    Business
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Available on Business plan</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

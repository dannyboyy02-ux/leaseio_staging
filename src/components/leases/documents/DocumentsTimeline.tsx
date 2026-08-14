// DocumentsTimeline — Phase 4 Checkpoint 4.
//
// Renders every uploaded lease_documents row for a lease, sorted by
// iteration_number ascending then version_number ascending. Marks the
// row with is_current_latest = true with a "Current latest" badge.
//
// Pure presentation. The parent owns data fetching + refresh.

import { Download, FileText, Loader2, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { documentTypeLabel, type DocumentType } from '@/lib/leaseDocuments';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18next from 'i18next';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { formatLocalizedDateTime } from '@/lib/dateFormatters';

export interface DocumentRow {
  id: string;
  document_type: DocumentType;
  iteration_number: number;
  version_number: number;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  uploaded_by: string;
  uploaded_at: string;
  notes: string | null;
  is_current_latest: boolean;
  uploader_name?: string | null;
}

interface Props {
  documents: DocumentRow[];
  loading?: boolean;
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function downloadDocument(doc: DocumentRow) {
  try {
    const { data, error } = await supabase.storage
      .from('lease-documents')
      .createSignedUrl(doc.storage_path, 120);
    if (error || !data?.signedUrl) {
      toast.error(i18next.t('documents.timeline.download_link_failed'));
      return;
    }
    window.open(data.signedUrl, '_blank');
  } catch (err) {
    console.error('document download error:', err);
    toast.error(i18next.t('documents.timeline.download_link_failed'));
  }
}

export function DocumentsTimeline({ documents, loading = false }: Props) {
  const { t, language } = useAppTranslation();
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-10 text-center text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">{t('documents.timeline.empty_title')}</p>
          <p className="text-xs mt-1">{t('documents.timeline.empty_hint')}</p>
        </CardContent>
      </Card>
    );
  }

  // Sort by iteration ascending, then version ascending. Stable across
  // renders so the timeline doesn't reflow when refetching.
  const sorted = [...documents].sort((a, b) => {
    if (a.iteration_number !== b.iteration_number) {
      return a.iteration_number - b.iteration_number;
    }
    return a.version_number - b.version_number;
  });

  return (
    <div className="space-y-2">
      {sorted.map((doc) => (
        <Card
          key={doc.id}
          className={cn(
            'overflow-hidden transition-colors',
            doc.is_current_latest && 'border-l-4 border-l-success',
          )}
        >
          <CardContent className="p-3 flex items-center gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">{doc.filename}</span>
                {doc.is_current_latest && (
                  <Badge variant="default" className="text-[10px] gap-0.5 px-1.5">
                    <Star className="h-2.5 w-2.5" />
                    {t('documents.timeline.current_latest')}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                <span>
                  {t('documents.timeline.iteration', { iteration: doc.iteration_number, version: doc.version_number })}
                </span>
                <span className="font-medium text-foreground/80">
                  {t(`documents.type.${doc.document_type}`, {
                    defaultValue: documentTypeLabel(doc.document_type),
                  })}
                </span>
                {doc.uploader_name && <span>{doc.uploader_name}</span>}
                <span>{formatLocalizedDateTime(doc.uploaded_at, language)}</span>
                {doc.file_size_bytes != null && (
                  <span>{formatFileSize(doc.file_size_bytes)}</span>
                )}
              </div>
              {doc.notes && (
                <p className="text-xs text-muted-foreground mt-1 italic line-clamp-2">
                  {doc.notes}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => downloadDocument(doc)}
              className="shrink-0"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              {t('common.download')}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

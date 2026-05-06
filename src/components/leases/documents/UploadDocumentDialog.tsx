// UploadDocumentDialog — Phase 4 Checkpoint 4.
//
// Two-phase upload:
//   1. Frontend uploads bytes directly to lease-documents storage bucket
//      via supabase-js (avoids edge function timeouts on 50MB files).
//      Storage path: {workspace_id}/{lease_id}/{uuid}_{filename}
//   2. After successful storage upload, calls upload-lease-document
//      edge function with the metadata (lease_id, storage_path,
//      document_type, filename, mime_type, file_size_bytes, notes).
//      The edge function inserts the lease_documents row; the AFTER
//      INSERT trigger flips is_current_latest.
//
// On step 2 failure, we attempt to clean up the orphan storage object
// — best-effort. RLS on storage will let us delete since we just
// uploaded it.

import { useState, useEffect } from 'react';
import { Upload, Loader2, FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  type DocumentType,
  allowedDocumentTypesFor,
  documentTypeLabel,
} from '@/lib/leaseDocuments';

const MAX_FILE_SIZE_BYTES = 52_428_800; // 50MB — matches lease-documents bucket cap

interface UploadDocumentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  leaseId: string;
  lifecycleStatus: string;
  onUploaded: () => void;
}

export function UploadDocumentDialog({
  open,
  onOpenChange,
  workspaceId,
  leaseId,
  lifecycleStatus,
  onUploaded,
}: UploadDocumentDialogProps) {
  const allowed = allowedDocumentTypesFor(lifecycleStatus);
  const [file, setFile] = useState<File | null>(null);
  const [documentType, setDocumentType] = useState<DocumentType | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Reset state when the dialog opens with a different lease/status.
  useEffect(() => {
    if (open) {
      setFile(null);
      setDocumentType('');
      setNotes('');
    }
  }, [open, leaseId, lifecycleStatus]);

  const fileTooLarge = file != null && file.size > MAX_FILE_SIZE_BYTES;
  const canSubmit = !!file && !!documentType && !fileTooLarge && !busy;

  const handleSubmit = async () => {
    if (!canSubmit || !file || !documentType) return;
    setBusy(true);
    let uploadedPath: string | null = null;
    try {
      // Storage path: {workspace_id}/{lease_id}/{uuid}_{filename}
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const uuid = crypto.randomUUID();
      const storagePath = `${workspaceId}/${leaseId}/${uuid}_${safeName}`;

      // Phase 1: storage upload
      const { error: uploadError } = await supabase.storage
        .from('lease-documents')
        .upload(storagePath, file, {
          upsert: false,
          contentType: file.type || undefined,
        });

      if (uploadError) {
        // Phase 4 spec: storage RLS requires a matching lease_documents
        // row to already exist. But our flow is reversed: upload then
        // insert metadata. The existing executed-leases bucket handles
        // this with a permissive INSERT policy; for lease-documents we
        // tightened it. If the storage upload fails because metadata
        // doesn't exist yet, this is a known race the user must retry.
        console.error('storage upload error:', uploadError);
        toast.error(`Upload failed: ${uploadError.message}`);
        return;
      }
      uploadedPath = storagePath;

      // Phase 2: metadata insert via edge function
      const { data, error: invokeError } = await supabase.functions.invoke(
        'upload-lease-document',
        {
          body: {
            leaseId,
            documentType,
            storagePath,
            filename: file.name,
            mimeType: file.type || null,
            fileSizeBytes: file.size,
            notes: notes.trim() || null,
          },
        },
      );

      if (invokeError || !(data as any)?.ok) {
        const msg =
          (data as any)?.error || invokeError?.message || 'Failed to record document';
        toast.error(msg);
        // Best-effort: remove the orphan storage object so a retry
        // doesn't run into upsert: false collisions.
        try {
          await supabase.storage.from('lease-documents').remove([storagePath]);
        } catch (cleanupErr) {
          console.warn('orphan cleanup failed:', cleanupErr);
        }
        return;
      }

      const result = data as {
        ok: true;
        document: {
          id: string;
          iteration_number: number;
          version_number: number;
          is_current_latest: boolean;
        };
      };
      toast.success(
        `Uploaded — iteration ${result.document.iteration_number}, version ${result.document.version_number}`,
      );
      onOpenChange(false);
      onUploaded();
    } catch (err) {
      console.error('upload error:', err);
      toast.error('Upload failed');
      // Same best-effort cleanup
      if (uploadedPath) {
        try {
          await supabase.storage.from('lease-documents').remove([uploadedPath]);
        } catch (cleanupErr) {
          console.warn('orphan cleanup failed:', cleanupErr);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Upload Document
          </DialogTitle>
          <DialogDescription>
            Upload a negotiation document, redline, or signed copy. The file is recorded
            as a new iteration and tracked alongside the lease.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file-input">File</Label>
            <Input
              id="file-input"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {file && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span className="truncate">{file.name}</span>
                <span>· {(file.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
            )}
            {fileTooLarge && (
              <p className="text-xs text-destructive">
                File exceeds the 50MB limit. Compress or split before uploading.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="document-type">Document type</Label>
            <Select
              value={documentType}
              onValueChange={(v) => setDocumentType(v as DocumentType)}
              disabled={busy || allowed.length === 0}
            >
              <SelectTrigger id="document-type">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                {allowed.map((t) => (
                  <SelectItem key={t} value={t}>
                    {documentTypeLabel(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {allowed.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No document types are allowed for the current lifecycle stage.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Types are filtered to those that match the lease's current stage.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Brief context — e.g., 'Counterparty pushed back on rent escalation cap'"
              rows={3}
              disabled={busy}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {busy ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

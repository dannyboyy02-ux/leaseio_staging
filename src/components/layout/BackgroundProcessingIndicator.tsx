import { Loader2 } from 'lucide-react';
import { useProcessing } from '@/contexts/ProcessingContext';

export function BackgroundProcessingIndicator() {
  const { jobs } = useProcessing();

  if (jobs.length === 0) return null;

  const label =
    jobs.length === 1
      ? `Abstracting "${jobs[0].filename}"...`
      : `Abstracting ${jobs.length} leases...`;

  return (
    <div className="fixed bottom-5 left-72 z-40 flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-lg">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-primary shrink-0" />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

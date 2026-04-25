import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

interface ProcessingJob {
  leaseId: string;
  filename: string;
  startedAt: number;
}

interface ProcessingContextValue {
  jobs: ProcessingJob[];
  startProcessing: (leaseId: string, filename: string) => void;
}

const ProcessingContext = createContext<ProcessingContextValue | null>(null);

export function ProcessingProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ProcessingJob[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const navigate = useNavigate();
  const { workspace } = useApp();

  // On mount: recover any leases still processing (handles page refresh)
  useEffect(() => {
    if (!workspace?.id) return;
    async function recoverJobs() {
      const { data } = await supabase
        .from('leases')
        .select('id, filename')
        .eq('workspace_id', workspace!.id)
        .in('status', ['Processing', 'Uploaded']);
      if (data && data.length > 0) {
        const recovered = data.map((l) => ({
          leaseId: l.id,
          filename: l.filename || 'Unknown file',
          startedAt: Date.now(),
        }));
        setJobs(recovered);
      }
    }
    recoverJobs();
  }, [workspace?.id]);

  // Polling loop — only runs when there are active jobs
  useEffect(() => {
    if (jobs.length === 0) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const poll = async () => {
      const jobsCopy = [...jobs];
      const idsToRemove: string[] = [];

      for (const job of jobsCopy) {
        try {
          const { data: lease } = await supabase
            .from('leases')
            .select('status, error_message')
            .eq('id', job.leaseId)
            .single();

          if (!lease) continue;

          if (lease.status === 'Ready') {
            idsToRemove.push(job.leaseId);
            toast.success(`${job.filename} is ready for review`, {
              duration: 10000,
              action: {
                label: 'Review Now',
                onClick: () => navigate(`/app/leases/${job.leaseId}/review`),
              },
            });
          } else if (lease.status === 'Failed') {
            idsToRemove.push(job.leaseId);
            toast.error(`Abstraction failed for ${job.filename}`);
          }
        } catch {
          // ignore transient polling errors
        }
      }

      if (idsToRemove.length > 0) {
        setJobs((prev) => prev.filter((j) => !idsToRemove.includes(j.leaseId)));
      }
    };

    pollingRef.current = setInterval(poll, 3000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [jobs, navigate]);

  const startProcessing = (leaseId: string, filename: string) => {
    setJobs((prev) => {
      if (prev.some((j) => j.leaseId === leaseId)) return prev;
      const next = [...prev, { leaseId, filename, startedAt: Date.now() }];
      const label =
        next.length === 1
          ? `Abstracting "${filename}"...`
          : `Abstracting ${next.length} documents...`;
      toast(label, {
        id: 'abstracting-indicator',
        duration: 3000,
        closeButton: true,
      });
      return next;
    });
  };

  return (
    <ProcessingContext.Provider value={{ jobs, startProcessing }}>
      {children}
    </ProcessingContext.Provider>
  );
}

export function useProcessing(): ProcessingContextValue {
  const ctx = useContext(ProcessingContext);
  if (!ctx) throw new Error('useProcessing must be used within a ProcessingProvider');
  return ctx;
}

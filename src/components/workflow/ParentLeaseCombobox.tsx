import { useState, useEffect } from 'react';
import { Check, ChevronsUpDown, FileText } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import type { PostedLease } from '@/types/workflow';

interface ParentLeaseComboboxProps {
  value: string | undefined;
  onValueChange: (value: string | undefined) => void;
  disabled?: boolean;
}

export function ParentLeaseCombobox({ 
  value, 
  onValueChange,
  disabled = false 
}: ParentLeaseComboboxProps) {
  const { workspace } = useApp();
  const [open, setOpen] = useState(false);
  const [leases, setLeases] = useState<PostedLease[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workspace?.id) return;

    const fetchPostedLeases = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('leases')
          .select('id, filename, tenant_name, landlord_name, lease_end')
          .eq('lifecycle_status', 'Posted')
          .eq('workspace_id', workspace.id)
          .order('uploaded_at', { ascending: false });

        if (error) throw error;
        setLeases((data || []) as PostedLease[]);
      } catch (error) {
        console.error('Error fetching posted leases:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPostedLeases();
  }, [workspace?.id]);

  const selectedLease = leases.find((lease) => lease.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || loading}
          className="w-full justify-between h-auto min-h-10 py-2"
        >
          {selectedLease ? (
            <div className="flex items-start gap-2 text-left">
              <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
              <div className="min-w-0">
                <p className="font-medium truncate">{selectedLease.filename}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {selectedLease.tenant_name || 'No tenant'} • 
                  {selectedLease.lease_end 
                    ? ` Ends ${format(new Date(selectedLease.lease_end), 'MMM yyyy')}`
                    : ' No end date'
                  }
                </p>
              </div>
            </div>
          ) : (
            <span className="text-muted-foreground">Select parent lease...</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by filename, tenant, or landlord..." />
          <CommandList>
            <CommandEmpty>
              {loading ? 'Loading leases...' : 'No posted leases found.'}
            </CommandEmpty>
            <CommandGroup>
              {leases.map((lease) => (
                <CommandItem
                  key={lease.id}
                  value={`${lease.filename} ${lease.tenant_name} ${lease.landlord_name}`}
                  onSelect={() => {
                    onValueChange(lease.id === value ? undefined : lease.id);
                    setOpen(false);
                  }}
                  className="flex items-start gap-2 py-2"
                >
                  <Check
                    className={cn(
                      "h-4 w-4 mt-0.5 shrink-0",
                      value === lease.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{lease.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {lease.tenant_name || 'No tenant'} 
                      {lease.landlord_name && ` • ${lease.landlord_name}`}
                    </p>
                    {lease.lease_end && (
                      <p className="text-xs text-muted-foreground">
                        Ends: {format(new Date(lease.lease_end), 'MMM d, yyyy')}
                      </p>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

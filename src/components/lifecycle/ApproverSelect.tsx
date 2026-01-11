import { useState, useEffect } from 'react';
import { Check, ChevronsUpDown, UserCheck } from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';

interface Approver {
  id: string;
  userId: string;
  email: string;
  name: string;
}

interface ApproverSelectProps {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  maxSelections?: number;
  disabled?: boolean;
}

export function ApproverSelect({
  selectedIds,
  onSelectionChange,
  maxSelections = 2,
  disabled = false,
}: ApproverSelectProps) {
  const { workspace } = useApp();
  const [open, setOpen] = useState(false);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchApprovers() {
      if (!workspace) return;

      try {
        const { data, error } = await supabase
          .from('workspace_approvers')
          .select(`
            id,
            user_id,
            profiles!workspace_approvers_user_id_fkey (
              email,
              first_name,
              last_name
            )
          `)
          .eq('workspace_id', workspace.id)
          .eq('is_active', true);

        if (error) {
          console.error('Error fetching approvers:', error);
          return;
        }

        const mappedApprovers: Approver[] = (data || []).map((a: any) => ({
          id: a.id,
          userId: a.user_id,
          email: a.profiles?.email || '',
          name: a.profiles?.first_name && a.profiles?.last_name 
            ? `${a.profiles.first_name} ${a.profiles.last_name}`
            : a.profiles?.email || 'Unknown',
        }));

        setApprovers(mappedApprovers);
      } catch (err) {
        console.error('Error:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchApprovers();
  }, [workspace]);

  const toggleApprover = (userId: string) => {
    if (selectedIds.includes(userId)) {
      onSelectionChange(selectedIds.filter(id => id !== userId));
    } else if (selectedIds.length < maxSelections) {
      onSelectionChange([...selectedIds, userId]);
    }
  };

  const selectedApprovers = approvers.filter(a => selectedIds.includes(a.userId));

  if (approvers.length === 0 && !loading) {
    return (
      <div className="p-4 border border-dashed border-border rounded-lg text-center text-muted-foreground">
        <UserCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm">No approvers configured</p>
        <p className="text-xs mt-1">Add approvers in Workspace Settings</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={disabled || loading}
          >
            {loading 
              ? 'Loading approvers...' 
              : selectedIds.length > 0
                ? `${selectedIds.length} approver${selectedIds.length > 1 ? 's' : ''} selected`
                : 'Select approvers'}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-full p-0" align="start">
          <Command>
            <CommandInput placeholder="Search approvers..." />
            <CommandList>
              <CommandEmpty>No approvers found.</CommandEmpty>
              <CommandGroup>
                {approvers.map((approver) => {
                  const isSelected = selectedIds.includes(approver.userId);
                  const isDisabled = !isSelected && selectedIds.length >= maxSelections;
                  
                  return (
                    <CommandItem
                      key={approver.id}
                      value={approver.email}
                      onSelect={() => toggleApprover(approver.userId)}
                      disabled={isDisabled}
                      className={cn(isDisabled && 'opacity-50')}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          isSelected ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <div className="flex flex-col">
                        <span>{approver.name}</span>
                        <span className="text-xs text-muted-foreground">{approver.email}</span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedApprovers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedApprovers.map((approver) => (
            <Badge key={approver.id} variant="secondary" className="gap-1">
              {approver.name}
              <button
                type="button"
                onClick={() => toggleApprover(approver.userId)}
                className="ml-1 hover:text-destructive"
                disabled={disabled}
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Select 1-{maxSelections} approvers
      </p>
    </div>
  );
}

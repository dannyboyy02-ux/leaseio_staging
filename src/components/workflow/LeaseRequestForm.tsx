import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Building2, Car, Cpu, Loader2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';

import { useApp } from '@/contexts/AppContext';
import { supabase } from '@/integrations/supabase/client';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createLeaseNotification } from '@/lib/leaseNotifications';
import type { CreateLeaseRequestData } from '@/types/workflow';

const leaseRequestSchema = z.object({
  requestTitle: z.string().trim().min(3, 'Request title is required'),
  category: z.enum(['property', 'equipment', 'vehicle', 'other']),
  requestingDepartment: z.string().trim().min(2, 'Requesting department is required'),
  requestUrgency: z.enum(['low', 'standard', 'urgent']).default('standard'),
  estimatedMonthlyCostMin: z.coerce.number().min(0).optional(),
  estimatedMonthlyCostMax: z.coerce.number().min(0).optional(),
  expectedStartDate: z.string().optional(),
  vendorName: z.string().trim().optional(),
  requestDescription: z.string().trim().optional(),
}).refine((data) => {
  if (data.estimatedMonthlyCostMin === undefined || data.estimatedMonthlyCostMax === undefined) {
    return true;
  }
  return data.estimatedMonthlyCostMin <= data.estimatedMonthlyCostMax;
}, {
  message: 'Minimum cost must be less than or equal to maximum cost',
  path: ['estimatedMonthlyCostMax'],
});

type LeaseRequestFormValues = z.infer<typeof leaseRequestSchema>;

interface LeaseRequestFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
}

const CATEGORY_OPTIONS = [
  { value: 'property', label: 'Property', icon: Building2 },
  { value: 'equipment', label: 'Equipment', icon: Cpu },
  { value: 'vehicle', label: 'Vehicle', icon: Car },
  { value: 'other', label: 'Other', icon: Building2 },
] as const;

export function LeaseRequestForm({ open, onOpenChange, onSuccess }: LeaseRequestFormProps) {
  const { user, workspace } = useApp();
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const form = useForm<LeaseRequestFormValues>({
    resolver: zodResolver(leaseRequestSchema),
    defaultValues: {
      requestTitle: '',
      category: 'property',
      requestingDepartment: '',
      requestUrgency: 'standard',
      expectedStartDate: '',
      vendorName: '',
      requestDescription: '',
    },
  });

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (!acceptedFiles.length) return;
    setFile(acceptedFiles[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    maxFiles: 1,
    maxSize: 20 * 1024 * 1024,
    accept: {
      'application/pdf': ['.pdf'],
    },
  });

  useEffect(() => {
    if (!open) {
      setFile(null);
      form.reset();
    }
  }, [open, form]);

  const selectedCategory = form.watch('category');

  const canSubmit = useMemo(() => !isSubmitting && !!user && !!workspace, [isSubmitting, user, workspace]);

  const notifyFinanceAdmins = async (leaseId: string, requestTitle: string) => {
    if (!workspace || !user) return;

    const { data: members, error: memberError } = await supabase
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspace.id)
      .eq('role', 'admin');

    if (memberError) {
      console.error('Failed to fetch finance recipients:', memberError);
      return;
    }

    const recipientIds = Array.from(new Set([
      workspace.ownerId,
      ...(members || []).map((member) => member.user_id).filter(Boolean),
    ].filter((id) => id && id !== user.id)));

    if (!recipientIds.length) return;

    await supabase.from('lease_activity_log').insert({
      lease_id: leaseId,
      user_id: null,
      activity_type: 'comment',
      details: {
        notification_type: 'finance_new_request',
        recipient_ids: recipientIds,
        message: `Finance admins notified about new request: ${requestTitle}`,
      },
    });
  };

  const submit = async (values: LeaseRequestFormValues) => {
    if (!user || !workspace) {
      toast.error('Please log in to create a lease request');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: CreateLeaseRequestData = {
        ...values,
        file: file ?? undefined,
      };

      const fileName = payload.file?.name ?? `${payload.requestTitle}.request`;
      const now = new Date().toISOString();

      const { data: lease, error: createError } = await supabase
        .from('leases')
        .insert({
          user_id: user.id,
          workspace_id: workspace.id,
          requestor_id: user.id,
          request_title: payload.requestTitle,
          category: payload.category,
          requesting_department: payload.requestingDepartment,
          request_urgency: payload.requestUrgency,
          expected_start_date: payload.expectedStartDate || null,
          estimated_monthly_cost_min: payload.estimatedMonthlyCostMin ?? null,
          estimated_monthly_cost_max: payload.estimatedMonthlyCostMax ?? null,
          estimated_term_min: payload.estimatedTermMonths ?? null,
          estimated_term_max: payload.estimatedTermMonths ?? null,
          vendor_name: payload.vendorName || null,
          request_description: payload.requestDescription || null,
          notes: payload.requestDescription || null,
          lifecycle_status: 'requested',
          lease_owner_id: user.id,
          initializer_id: user.id,
          status: 'draft',
          lease_type: payload.category,
          filename: fileName,
          uploaded_at: now,
        })
        .select('id')
        .single();

      if (createError || !lease) throw createError ?? new Error('Failed to create lease request');

      if (payload.file) {
        const safeName = payload.file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const storagePath = `${user.id}/${lease.id}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from('leases')
          .upload(storagePath, payload.file, { upsert: false });

        if (uploadError) {
          throw uploadError;
        }

        await supabase
          .from('leases')
          .update({ storage_path: storagePath, filename: payload.file.name })
          .eq('id', lease.id);
      }

      await supabase.from('lease_activity_log').insert({
        lease_id: lease.id,
        user_id: user.id,
        activity_type: 'created',
        to_status: 'requested',
        details: {
          request_title: payload.requestTitle,
          requesting_department: payload.requestingDepartment,
          has_attachment: Boolean(payload.file),
        },
      });

      await notifyFinanceAdmins(lease.id, payload.requestTitle);
      await createLeaseNotification({
        leaseId: lease.id,
        eventType: 'new_request',
        description: `New lease request created: ${payload.requestTitle}`,
      });

      toast.success('Lease request created');
      onOpenChange(false);
      onSuccess?.(lease.id);
      navigate(`/app/leases/${lease.id}`);
    } catch (error) {
      console.error('Failed to create lease request:', error);
      toast.error('Failed to create lease request');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[94vh]">
        <DrawerHeader>
          <DrawerTitle>Create Lease Request</DrawerTitle>
          <DrawerDescription>
            Log lease activity early so finance has visibility before execution.
          </DrawerDescription>
        </DrawerHeader>

        <div className="px-4 pb-4 overflow-y-auto">
          <Form {...form}>
            <form id="lease-request-form" onSubmit={form.handleSubmit(submit)} className="space-y-4">
              <FormField
                control={form.control}
                name="requestTitle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Request Title</FormLabel>
                    <FormControl>
                      <Input placeholder="Warehouse expansion - Building C" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {CATEGORY_OPTIONS.map((option) => {
                        const Icon = option.icon;
                        const selected = selectedCategory === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => field.onChange(option.value)}
                            className={cn(
                              'rounded-lg border p-3 text-left transition-colors',
                              selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30',
                            )}
                          >
                            <div className="flex items-center gap-2 text-sm font-medium">
                              <Icon className="h-4 w-4" />
                              {option.label}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="requestingDepartment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Requesting Department</FormLabel>
                    <FormControl>
                      <Input placeholder="Operations" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="requestUrgency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Urgency</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="flex gap-6">
                        {['low', 'standard', 'urgent'].map((urgency) => (
                          <div key={urgency} className="flex items-center gap-2">
                            <RadioGroupItem value={urgency} id={`urgency-${urgency}`} />
                            <Label htmlFor={`urgency-${urgency}`} className="capitalize">{urgency}</Label>
                          </div>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="estimatedMonthlyCostMin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Estimated Monthly Cost (Min)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="2500"
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value === '' ? undefined : Number(event.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="estimatedMonthlyCostMax"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Estimated Monthly Cost (Max)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="5000"
                          value={field.value ?? ''}
                          onChange={(event) => field.onChange(event.target.value === '' ? undefined : Number(event.target.value))}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="expectedStartDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expected Start Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="vendorName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vendor/Counterparty</FormLabel>
                    <FormControl>
                      <Input placeholder="ABC Logistics" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="requestDescription"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description / Notes</FormLabel>
                    <FormControl>
                      <Textarea rows={4} placeholder="What do we need and why?" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="space-y-2">
                <Label>Attach Document (Optional PDF)</Label>
                <div
                  {...getRootProps()}
                  className={cn(
                    'cursor-pointer rounded-lg border-2 border-dashed p-5 text-center transition-colors',
                    isDragActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                  )}
                >
                  <input {...getInputProps()} />
                  <Upload className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {file ? file.name : 'Drop PDF here or click to browse'}
                  </p>
                </div>

                {file && (
                  <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span className="truncate">{file.name}</span>
                    <Button size="icon" variant="ghost" type="button" onClick={() => setFile(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </form>
          </Form>
        </div>

        <DrawerFooter>
          <Button
            type="submit"
            form="lease-request-form"
            disabled={!canSubmit}
          >
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Request
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

import { useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDropzone } from 'react-dropzone';
import { Building2, Cpu, Upload, FileText, Loader2, X } from 'lucide-react';

import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerClose,
} from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { WorkflowLeaseType } from '@/types/workflow';

const createLeaseSchema = z.object({
  leaseType: z.enum(['Real Estate', 'Equipment']),
  approverEmail: z.string().email('Please enter a valid email address'),
});

type CreateLeaseFormValues = z.infer<typeof createLeaseSchema>;

interface CreateLeaseDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
}

export function CreateLeaseDrawer({ open, onOpenChange, onSuccess }: CreateLeaseDrawerProps) {
  const { user, workspace } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<CreateLeaseFormValues>({
    resolver: zodResolver(createLeaseSchema),
    defaultValues: {
      leaseType: 'Real Estate',
      approverEmail: '',
    },
  });

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
    },
    maxFiles: 1,
    maxSize: 20 * 1024 * 1024, // 20MB
  });

  const handleSubmit = async (values: CreateLeaseFormValues) => {
    if (!user || !workspace) {
      toast.error('Please log in to create a lease');
      return;
    }

    if (!file) {
      toast.error('Please upload a PDF document');
      return;
    }

    setIsSubmitting(true);

    try {
      // Upload file to Supabase Storage
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${crypto.randomUUID()}.${fileExt}`;
      
      const { error: uploadError } = await supabase.storage
        .from('leases')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // Create lease record
      const { data: lease, error: insertError } = await supabase
        .from('leases')
        .insert({
          user_id: user.id,
          workspace_id: workspace.id,
          filename: file.name,
          storage_path: fileName,
          status: 'Pending Approval',
          lifecycle_status: 'Pending Approval',
          lease_type: values.leaseType,
          approver_email: values.approverEmail,
          initializer_id: user.id,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      toast.success('Lease created and sent for approval');
      onOpenChange(false);
      form.reset();
      setFile(null);
      onSuccess?.(lease.id);
    } catch (error: any) {
      console.error('Error creating lease:', error);
      toast.error(error.message || 'Failed to create lease');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedType = form.watch('leaseType');

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>Create New Lease</DrawerTitle>
          <DrawerDescription>
            Submit a lease for approval and abstraction
          </DrawerDescription>
        </DrawerHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="px-4 pb-4 space-y-6">
            {/* Lease Type Toggle */}
            <FormField
              control={form.control}
              name="leaseType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Lease Type</FormLabel>
                  <FormControl>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        type="button"
                        variant={field.value === 'Real Estate' ? 'default' : 'outline'}
                        className={cn(
                          'h-16 flex flex-col gap-1',
                          field.value === 'Real Estate' && 'ring-2 ring-primary ring-offset-2'
                        )}
                        onClick={() => field.onChange('Real Estate')}
                      >
                        <Building2 className="h-5 w-5" />
                        <span className="text-xs">Real Estate</span>
                      </Button>
                      <Button
                        type="button"
                        variant={field.value === 'Equipment' ? 'default' : 'outline'}
                        className={cn(
                          'h-16 flex flex-col gap-1',
                          field.value === 'Equipment' && 'ring-2 ring-primary ring-offset-2'
                        )}
                        onClick={() => field.onChange('Equipment')}
                      >
                        <Cpu className="h-5 w-5" />
                        <span className="text-xs">Equipment</span>
                      </Button>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Approver Email */}
            <FormField
              control={form.control}
              name="approverEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Approver Email</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      placeholder="approver@company.com"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* File Dropzone */}
            <div className="space-y-2">
              <Label>Lease Document</Label>
              <div
                {...getRootProps()}
                className={cn(
                  'border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors',
                  isDragActive
                    ? 'border-primary bg-primary/5'
                    : 'border-muted-foreground/25 hover:border-primary/50',
                  file && 'border-green-500 bg-green-50'
                )}
              >
                <input {...getInputProps()} />
                {file ? (
                  <div className="flex items-center justify-center gap-3">
                    <FileText className="h-8 w-8 text-green-600" />
                    <div className="text-left">
                      <p className="font-medium text-green-700">{file.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {isDragActive
                        ? 'Drop the PDF here...'
                        : 'Drag & drop a PDF, or click to select'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Max file size: 20MB
                    </p>
                  </>
                )}
              </div>
            </div>

            <DrawerFooter className="px-0">
              <Button type="submit" disabled={isSubmitting || !file}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  'Submit for Approval'
                )}
              </Button>
              <DrawerClose asChild>
                <Button variant="outline" type="button">Cancel</Button>
              </DrawerClose>
            </DrawerFooter>
          </form>
        </Form>
      </DrawerContent>
    </Drawer>
  );
}

import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useDropzone } from 'react-dropzone';
import { 
  Building2, 
  Cpu, 
  Upload, 
  FileText, 
  Loader2, 
  X, 
  ChevronRight, 
  ChevronLeft,
  FilePlus,
  FileEdit,
  PenLine,
} from 'lucide-react';

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
import { ParentLeaseCombobox } from './ParentLeaseCombobox';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { WorkflowLeaseType, LeaseCategory } from '@/types/workflow';

const createLeaseSchema = z.object({
  leaseType: z.enum(['Real Estate', 'Equipment']),
  category: z.enum(['New Lease', 'Lease Amendment']),
  approverEmail: z.string().email('Please enter a valid email address'),
  parentLeaseId: z.string().uuid().optional(),
}).refine((data) => {
  if (data.category === 'Lease Amendment' && !data.parentLeaseId) {
    return false;
  }
  return true;
}, {
  message: 'Please select a parent lease for amendments',
  path: ['parentLeaseId'],
});

type CreateLeaseFormValues = z.infer<typeof createLeaseSchema>;

interface CreateLeaseDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (leaseId: string) => void;
}

const STEPS = ['Type', 'Category', 'Parent', 'Details'] as const;

export function CreateLeaseDrawer({ open, onOpenChange, onSuccess }: CreateLeaseDrawerProps) {
  const { user, workspace } = useApp();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [step, setStep] = useState(1);

  const form = useForm<CreateLeaseFormValues>({
    resolver: zodResolver(createLeaseSchema),
    defaultValues: {
      leaseType: 'Real Estate',
      category: 'New Lease',
      approverEmail: '',
      parentLeaseId: undefined,
    },
  });

  const category = form.watch('category');
  const leaseType = form.watch('leaseType');
  const parentLeaseId = form.watch('parentLeaseId');

  // Reset step when drawer closes
  useEffect(() => {
    if (!open) {
      setStep(1);
      setFile(null);
      form.reset();
    }
  }, [open, form]);

  // Skip parent step for New Lease
  const totalSteps = category === 'Lease Amendment' ? 4 : 3;
  const currentStepLabel = category === 'Lease Amendment' 
    ? STEPS[step - 1] 
    : step === 3 ? 'Details' : STEPS[step - 1];

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
    maxSize: 20 * 1024 * 1024,
  });

  const handleNext = () => {
    if (step === 2 && category === 'New Lease') {
      // Skip parent selection for new leases
      setStep(4);
    } else if (step < 4) {
      setStep(step + 1);
    }
  };

  const handleBack = () => {
    if (step === 4 && category === 'New Lease') {
      // Go back to category for new leases
      setStep(2);
    } else if (step > 1) {
      setStep(step - 1);
    }
  };

  const canProceed = () => {
    switch (step) {
      case 1: return !!leaseType;
      case 2: return !!category;
      case 3: return category === 'New Lease' || !!parentLeaseId;
      case 4: return true;
      default: return false;
    }
  };

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
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/${crypto.randomUUID()}.${fileExt}`;
      
      const { error: uploadError } = await supabase.storage
        .from('leases')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

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
          category: values.category,
          approver_email: values.approverEmail,
          initializer_id: user.id,
          parent_lease_id: values.category === 'Lease Amendment' ? values.parentLeaseId : null,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      toast.success('Lease created and sent for approval');
      onOpenChange(false);
      form.reset();
      setFile(null);
      setStep(1);
      onSuccess?.(lease.id);
    } catch (error: any) {
      console.error('Error creating lease:', error);
      toast.error(error.message || 'Failed to create lease');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleManualEntry = () => {
    onOpenChange(false);
    navigate('/app/leases/new', { 
      state: { 
        workflowCategory: category,
        workflowLeaseType: leaseType,
        parentLeaseId: parentLeaseId,
      }
    });
  };

  const renderStepContent = () => {
    switch (step) {
      case 1:
        return (
          <FormField
            control={form.control}
            name="leaseType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>What type of lease is this?</FormLabel>
                <FormControl>
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      type="button"
                      variant={field.value === 'Real Estate' ? 'default' : 'outline'}
                      className={cn(
                        'h-24 flex flex-col gap-2',
                        field.value === 'Real Estate' && 'ring-2 ring-primary ring-offset-2'
                      )}
                      onClick={() => field.onChange('Real Estate')}
                    >
                      <Building2 className="h-8 w-8" />
                      <span>Real Estate</span>
                    </Button>
                    <Button
                      type="button"
                      variant={field.value === 'Equipment' ? 'default' : 'outline'}
                      className={cn(
                        'h-24 flex flex-col gap-2',
                        field.value === 'Equipment' && 'ring-2 ring-primary ring-offset-2'
                      )}
                      onClick={() => field.onChange('Equipment')}
                    >
                      <Cpu className="h-8 w-8" />
                      <span>Equipment</span>
                    </Button>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        );

      case 2:
        return (
          <FormField
            control={form.control}
            name="category"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Is this a new lease or an amendment?</FormLabel>
                <FormControl>
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      type="button"
                      variant={field.value === 'New Lease' ? 'default' : 'outline'}
                      className={cn(
                        'h-24 flex flex-col gap-2',
                        field.value === 'New Lease' && 'ring-2 ring-primary ring-offset-2'
                      )}
                      onClick={() => field.onChange('New Lease')}
                    >
                      <FilePlus className="h-8 w-8" />
                      <span>New Lease</span>
                    </Button>
                    <Button
                      type="button"
                      variant={field.value === 'Lease Amendment' ? 'default' : 'outline'}
                      className={cn(
                        'h-24 flex flex-col gap-2',
                        field.value === 'Lease Amendment' && 'ring-2 ring-primary ring-offset-2'
                      )}
                      onClick={() => field.onChange('Lease Amendment')}
                    >
                      <FileEdit className="h-8 w-8" />
                      <span>Amendment</span>
                    </Button>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        );

      case 3:
        return (
          <FormField
            control={form.control}
            name="parentLeaseId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Select the original lease being amended</FormLabel>
                <FormControl>
                  <ParentLeaseCombobox
                    value={field.value}
                    onValueChange={field.onChange}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        );

      case 4:
        return (
          <div className="space-y-6">
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
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader>
          <DrawerTitle>Create New Lease</DrawerTitle>
          <DrawerDescription>
            Step {category === 'New Lease' ? (step === 4 ? 3 : step) : step} of {totalSteps}: {currentStepLabel}
          </DrawerDescription>
        </DrawerHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="px-4 pb-4 space-y-6">
            {renderStepContent()}

            <DrawerFooter className="px-0">
              <div className="flex gap-2 w-full">
                {step > 1 && (
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={handleBack}
                    className="flex-1"
                  >
                    <ChevronLeft className="h-4 w-4 mr-1" />
                    Back
                  </Button>
                )}
                
                {step < 4 && !(step === 2 && category === 'New Lease' && step === 2) && (
                  <Button 
                    type="button" 
                    onClick={handleNext}
                    disabled={!canProceed()}
                    className="flex-1"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                )}

                {(step === 4 || (step === 2 && category === 'New Lease')) && step !== 4 && (
                  <Button 
                    type="button" 
                    onClick={handleNext}
                    className="flex-1"
                  >
                    Next
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                )}

                {step === 4 && (
                  <Button 
                    type="submit" 
                    disabled={isSubmitting || !file}
                    className="flex-1"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      'Submit for Approval'
                    )}
                  </Button>
                )}
              </div>

              <Button 
                type="button" 
                variant="ghost" 
                onClick={handleManualEntry}
                className="w-full text-muted-foreground"
              >
                <PenLine className="h-4 w-4 mr-2" />
                Enter Details Manually
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

import { useState, useCallback } from 'react';
import { t } from 'i18next';
import { supabase } from '@/integrations/supabase/client';
import { useApp } from '@/contexts/AppContext';
import { toast } from 'sonner';
import type { 
  LifecycleStatus, 
  LeaseCategory, 
  ApprovalType, 
  ApprovalAction,
  LifecycleLease,
  LeaseApprover,
  LeaseActivityLog,
} from '@/types/lifecycle';
import { getApprovalRequirements, getInitialStatusAfterSubmission } from '@/lib/approvalRouting';

interface CreateDraftLeaseInput {
  category: LeaseCategory;
  businessUnit: string;
  estimatedTermMin?: number;
  estimatedTermMax?: number;
  estimatedMonthlyCostMin?: number;
  estimatedMonthlyCostMax?: number;
  notes?: string;
  // Workflow fields
  workflowCategory?: 'New Lease' | 'Lease Amendment';
  workflowLeaseType?: 'Real Estate' | 'Equipment';
  parentLeaseId?: string;
  // Pilot intake fields — all optional so existing callers are unaffected
  requestTitle?: string;
  requestingDepartment?: string;
  tenantName?: string;
  monthlyRent?: number;
  leaseStart?: string;
  leaseEnd?: string;
  escalationType?: string;
  escalationRate?: number;
}

interface SubmitForApprovalInput {
  leaseId: string;
  approverIds: string[];
}

export function useLifecycleWorkflow() {
  const { workspace, user } = useApp();
  const [isLoading, setIsLoading] = useState(false);

  const isBusinessPlan = workspace?.plan === 'business';

  // Create a lease request and route it based on workspace approval config
  const createDraftLease = useCallback(async (input: CreateDraftLeaseInput): Promise<string | null> => {
    if (!user || !workspace) {
      toast.error(t('workflow.lifecycle.login_required'));
      return null;
    }

    if (!isBusinessPlan) {
      toast.error(t('workflow.lifecycle.business_only'));
      return null;
    }

    setIsLoading(true);
    try {
      // Derive term months from actual dates if provided
      let derivedTermMonths: number | null = null;
      if (input.leaseStart && input.leaseEnd) {
        derivedTermMonths = Math.max(
          1,
          Math.round(
            (new Date(input.leaseEnd).getTime() - new Date(input.leaseStart).getTime()) /
              ((365.25 / 12) * 24 * 60 * 60 * 1000)
          )
        );
      }

      // Determine initial lifecycle status via workspace approval routing
      const [rolesResult, wsResult] = await Promise.all([
        supabase
          .from('workspace_roles')
          .select('role')
          .eq('workspace_id', workspace.id),
        (supabase as any)
          .from('workspaces')
          .select('approval_threshold')
          .eq('id', workspace.id)
          .single(),
      ]);

      const roles = (rolesResult.data || []).map((r: any) => r.role as string);
      const hasManagerApprovers = roles.includes('manager_approver');
      const hasFinancialApprovers = roles.includes('financial_approver');
      const approvalThreshold: number | null = wsResult.data?.approval_threshold ?? null;

      // Prefer actual monthly rent over range estimates for commitment routing
      const monthlyForRouting =
        input.monthlyRent ?? input.estimatedMonthlyCostMax ?? input.estimatedMonthlyCostMin ?? 0;
      const termForRouting =
        derivedTermMonths ?? input.estimatedTermMax ?? input.estimatedTermMin ?? 12;
      const estimatedCommitment = monthlyForRouting * termForRouting;

      const requirements = getApprovalRequirements({
        totalCashCommitment: estimatedCommitment,
        approvalThreshold,
        hasManagerApprovers,
        hasFinancialApprovers,
        covenantFlagged: false,
      });

      const initialStatus = getInitialStatusAfterSubmission(requirements);
      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from('leases')
        .insert({
          user_id: user.id,
          requestor_id: user.id,
          lease_owner_id: user.id,
          workspace_id: workspace.id,
          lifecycle_status: initialStatus,
          category: input.category,
          asset_type: input.category,
          business_unit: input.businessUnit,
          requesting_department: input.requestingDepartment ?? input.businessUnit,
          request_title:
            input.requestTitle ??
            `${input.workflowCategory || 'New Lease'} — ${input.businessUnit}`,
          tenant_name: input.tenantName ?? null,
          monthly_payment: input.monthlyRent ?? null,
          lease_start: input.leaseStart ?? null,
          lease_end: input.leaseEnd ?? null,
          term_months: derivedTermMonths,
          escalation_type: input.escalationType ?? null,
          escalation_rate: input.escalationRate ?? null,
          needs_escalation_review: input.escalationType === 'index' ? true : null,
          estimated_term_min: input.estimatedTermMin,
          estimated_term_max: input.estimatedTermMax,
          estimated_monthly_cost_min: input.estimatedMonthlyCostMin,
          estimated_monthly_cost_max: input.estimatedMonthlyCostMax,
          notes: input.notes,
          filename: `Request - ${input.businessUnit || input.category}`,
          lease_type: input.workflowLeaseType,
          parent_lease_id: input.parentLeaseId,
          uploaded_at: now,
          submitted_for_approval_at: now,
        })
        .select('id')
        .single();

      if (error) throw error;

      // Log activity
      await supabase.from('lease_activity_log').insert({
        lease_id: data.id,
        user_id: user.id,
        activity_type: 'created',
        to_status: initialStatus,
        details: {
          category: input.category,
          business_unit: input.businessUnit,
          initial_status: initialStatus,
          requires_manager: requirements.requiresManagerApproval,
          requires_financial: requirements.requiresFinancialApproval,
        },
      });

      const statusMessageKeys: Record<string, string> = {
        submitted: 'workflow.lifecycle.submitted_manager',
        under_review: 'workflow.lifecycle.submitted_financial',
        approved: 'workflow.lifecycle.auto_approved',
      };
      toast.success(
        statusMessageKeys[initialStatus]
          ? t(statusMessageKeys[initialStatus])
          : t('workflow.lifecycle.request_submitted'),
      );
      return data.id;
    } catch (error) {
      console.error('Error creating lease request:', error);
      toast.error(t('workflow.lifecycle.submit_failed'));
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [user, workspace, isBusinessPlan]);

  // Submit lease for internal approval
  const submitForApproval = useCallback(async (input: SubmitForApprovalInput): Promise<boolean> => {
    if (!user) {
      toast.error(t('workflow.lifecycle.login_required'));
      return false;
    }

    if (input.approverIds.length === 0 || input.approverIds.length > 2) {
      toast.error(t('workflow.lifecycle.select_approvers'));
      return false;
    }

    setIsLoading(true);
    try {
      // Update lease status
      const { error: leaseError } = await supabase
        .from('leases')
        .update({
          lifecycle_status: 'submitted',
          submitted_for_approval_at: new Date().toISOString(),
        })
        .eq('id', input.leaseId);

      if (leaseError) throw leaseError;

      // Assign approvers
      const approverInserts = input.approverIds.map(approverId => ({
        lease_id: input.leaseId,
        approver_id: approverId,
        approval_type: 'internal' as ApprovalType,
      }));

      const { error: approversError } = await supabase
        .from('lease_approvers')
        .insert(approverInserts);

      if (approversError) throw approversError;

      // Log activity
      await supabase.from('lease_activity_log').insert({
        lease_id: input.leaseId,
        user_id: user.id,
        activity_type: 'status_change',
        to_status: 'submitted',
      });

      toast.success(t('workflow.lifecycle.submitted_for_approval'));
      return true;
    } catch (error) {
      console.error('Error submitting for approval:', error);
      toast.error(t('workflow.lifecycle.submit_approval_failed'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  // Take approval action
  const takeApprovalAction = useCallback(async (
    leaseId: string,
    approvalType: ApprovalType,
    action: ApprovalAction,
    comment?: string
  ): Promise<boolean> => {
    if (!user) {
      toast.error(t('workflow.lifecycle.login_required'));
      return false;
    }

    if ((action === 'send_back' || action === 'pause') && !comment?.trim()) {
      toast.error(t('workflow.lifecycle.comment_required'));
      return false;
    }

    setIsLoading(true);
    try {
      const { data: lease, error: fetchError } = await supabase
        .from('leases')
        .select('lifecycle_status')
        .eq('id', leaseId)
        .single();

      if (fetchError) throw fetchError;

      const currentStatus = lease.lifecycle_status as LifecycleStatus;
      let newStatus: LifecycleStatus = currentStatus;

      if (action === 'approve') {
        if (approvalType === 'internal') {
          newStatus = 'under_review';
        } else {
          newStatus = 'approved';
        }
      } else if (action === 'send_back') {
        newStatus = 'submitted';
      } else if (action === 'reject') {
        newStatus = 'rejected';
      }

      const { error: actionError } = await supabase
        .from('lease_approval_actions')
        .insert({
          lease_id: leaseId,
          approver_id: user.id,
          approval_type: approvalType,
          action: action,
          comment: comment || null,
        });

      if (actionError) throw actionError;

      if (newStatus !== currentStatus) {
        const updateData: Record<string, unknown> = {
          lifecycle_status: newStatus,
        };

        if (action === 'approve' && approvalType === 'internal') {
          updateData.manager_approved_by = user.id;
          updateData.manager_approved_at = new Date().toISOString();
        } else if (action === 'approve' && approvalType === 'execution') {
          updateData.financial_approved_by = user.id;
          updateData.financial_approved_at = new Date().toISOString();
        } else if (action === 'reject') {
          updateData.rejection_reason = comment;
        }

        const { error: updateError } = await supabase
          .from('leases')
          .update(updateData)
          .eq('id', leaseId);

        if (updateError) throw updateError;
      }

      const activityType = action === 'approve' ? 'approval' 
        : action === 'reject' ? 'rejection'
        : action === 'send_back' ? 'send_back'
        : 'pause';

      await supabase.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: activityType,
        from_status: currentStatus,
        to_status: newStatus,
        details: { approval_type: approvalType, comment },
      });

      const actionMessageKeys: Record<ApprovalAction, string> = {
        approve: 'workflow.lifecycle.action_approve',
        send_back: 'workflow.lifecycle.action_send_back',
        reject: 'workflow.lifecycle.action_reject',
        pause: 'workflow.lifecycle.action_pause',
      };

      toast.success(t(actionMessageKeys[action]));
      return true;
    } catch (error) {
      console.error('Error taking approval action:', error);
      toast.error(t('workflow.lifecycle.action_failed'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  // Send manual nudge
  const sendNudge = useCallback(async (leaseId: string): Promise<boolean> => {
    if (!user) {
      toast.error(t('workflow.lifecycle.login_required'));
      return false;
    }

    setIsLoading(true);
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentNudges, error: nudgeCheckError } = await supabase
        .from('lease_nudges')
        .select('id')
        .eq('lease_id', leaseId)
        .eq('nudge_type', 'manual')
        .gte('sent_at', yesterday);

      if (nudgeCheckError) throw nudgeCheckError;

      if (recentNudges && recentNudges.length > 0) {
        toast.error(t('workflow.lifecycle.nudge_limit'));
        return false;
      }

      const { error: nudgeError } = await supabase
        .from('lease_nudges')
        .insert({
          lease_id: leaseId,
          sent_by: user.id,
          nudge_type: 'manual',
          channel: 'in_app',
        });

      if (nudgeError) throw nudgeError;

      await supabase.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: 'nudge_sent',
        details: { nudge_type: 'manual' },
      });

      toast.success(t('workflow.lifecycle.nudge_sent'));
      return true;
    } catch (error) {
      console.error('Error sending nudge:', error);
      toast.error(t('workflow.nudge.send_failed'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  // Upload document to lease
  const uploadLeaseDocument = useCallback(async (
    leaseId: string,
    file: File
  ): Promise<boolean> => {
    if (!user || !workspace) {
      toast.error(t('workflow.lifecycle.login_required'));
      return false;
    }

    setIsLoading(true);
    try {
      const storagePath = `${workspace.id}/${leaseId}/${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from('leases')
        .upload(storagePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from('leases')
        .update({
          filename: file.name,
          storage_path: storagePath,
        })
        .eq('id', leaseId);

      if (updateError) throw updateError;

      await supabase.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: 'document_upload',
        details: { filename: file.name },
      });

      toast.success(t('workflow.lifecycle.doc_uploaded'));
      return true;
    } catch (error) {
      console.error('Error uploading document:', error);
      toast.error(t('workflow.lifecycle.doc_upload_failed'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user, workspace]);

  // Submit for execution approval
  const submitForExecutionApproval = useCallback(async (
    leaseId: string,
    approverIds: string[]
  ): Promise<boolean> => {
    if (!user) {
      toast.error(t('workflow.lifecycle.login_required'));
      return false;
    }

    if (approverIds.length === 0 || approverIds.length > 2) {
      toast.error(t('workflow.lifecycle.select_approvers'));
      return false;
    }

    setIsLoading(true);
    try {
      const { error: leaseError } = await supabase
        .from('leases')
        .update({
          lifecycle_status: 'approved',
        })
        .eq('id', leaseId);

      if (leaseError) throw leaseError;

      const approverInserts = approverIds.map(approverId => ({
        lease_id: leaseId,
        approver_id: approverId,
        approval_type: 'execution' as ApprovalType,
      }));

      const { error: approversError } = await supabase
        .from('lease_approvers')
        .insert(approverInserts);

      if (approversError) throw approversError;

      await supabase.from('lease_activity_log').insert({
        lease_id: leaseId,
        user_id: user.id,
        activity_type: 'status_change',
        to_status: 'approved',
      });

      toast.success(t('workflow.lifecycle.exec_submitted'));
      return true;
    } catch (error) {
      console.error('Error submitting for execution approval:', error);
      toast.error(t('workflow.lifecycle.exec_submit_failed'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  return {
    isBusinessPlan,
    isLoading,
    createDraftLease,
    submitForApproval,
    takeApprovalAction,
    sendNudge,
    uploadLeaseDocument,
    submitForExecutionApproval,
  };
}

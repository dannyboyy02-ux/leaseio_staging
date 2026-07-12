// Localized display wrappers around the pure lifecycleStates label helpers.
//
// lifecycleStates.ts stays i18n-free on purpose — it has a Deno mirror
// (supabase/functions/_shared/approval_chain.ts ecosystem) and pure unit
// tests that pin the canonical English vocabulary. UI code imports THESE
// wrappers instead, so lifecycle/stage/role vocabulary renders in the
// viewer's language and falls back to the canonical English label for any
// value without a locale key (e.g. an unknown role's snake_case humanization).

import { t } from 'i18next';
import {
  displayLabel,
  stageLabel,
  roleLabel,
  type LifecycleStatus,
} from '@/lib/lifecycleStates';
import { LIFECYCLE_STATUS_CONFIG } from '@/types/lifecycle';

/** Full status label, e.g. under_review → "Under Review" / "En revisión". */
export function localizedStatusLabel(status: LifecycleStatus): string {
  return t(`lifecycle.status.${status}`, { defaultValue: displayLabel(status) });
}

/** Compact pill label, e.g. under_review → "Review" / "Revisión". */
export function localizedStatusShortLabel(status: LifecycleStatus): string {
  const short = LIFECYCLE_STATUS_CONFIG[status]?.shortLabel;
  return t(`lifecycle.status_short.${status}`, {
    defaultValue: short ?? localizedStatusLabel(status),
  });
}

/** Chain-step stage, e.g. concept → "Initial approval" / "Aprobación inicial". */
export function localizedStageLabel(stage: string): string {
  return t(`lifecycle.stage.${stage}`, { defaultValue: stageLabel(stage) });
}

/** Workspace functional role, e.g. financial_approver → "Finance" / "Finanzas". */
export function localizedRoleLabel(role: string | null | undefined): string {
  if (!role) return '';
  return t(`lifecycle.role.${role}`, { defaultValue: roleLabel(role) });
}

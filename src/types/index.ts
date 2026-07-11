// Core Types for LeaseIO

// Single source of truth lives in src/config/pricing.ts — re-exported here
// so existing `@/types` imports keep working. (A duplicated literal union
// here drifted and broke the build when 'vault' landed — audit 2026-06-13.)
import type { SubscriptionPlan } from '@/config/pricing';
export type { SubscriptionPlan };

export type BillingInterval = 'monthly' | 'annual';

// Read-only billing summary returned by the `get-billing-summary` edge function
// (saved payment method + recent invoices for the in-app Billing tab). Carries
// brand + last4 only — never a full PAN or PaymentMethod secret. `type`/`label`
// let the tab render non-card methods (Stripe Link, Apple Pay, ACH) instead of
// silently showing "no payment method" (billing incident 2026-07-11).
export interface BillingCard {
  type?: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  walletLabel?: string | null;
  label?: string;
}

export interface BillingInvoice {
  id: string;
  created: number; // unix seconds
  total: number; // minor units (cents)
  currency: string; // e.g. 'usd'
  status: string | null; // paid | open | void | uncollectible | draft
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export interface BillingSummary {
  ok: true;
  card: BillingCard | null;
  invoices: BillingInvoice[];
  reason?: 'no_customer';
}

export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export type LeaseType = 'master' | 'amendment';

export type LeaseStatus = 'draft' | 'processing' | 'review' | 'final' | 'archived';

export type DocumentStatus = 'uploading' | 'processing' | 'ready' | 'error';

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  companyName?: string;
  address?: string;
  timezone: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  plan: SubscriptionPlan;
  maxActiveLeases: number;
  activeLeasesUsed: number;
  maxArchivedLeases: number;
  archivedLeasesUsed: number;
  documentLimit: number;
  // Extra monthly-abstraction + active-lease capacity from active document
  // packs (sum of pack sizes, mirrored from Stripe by the webhook). 0 when no
  // pack. Effective allowance = documentLimit + addonDocumentCapacity.
  addonDocumentCapacity: number;
  // Spendable single-lease credits ("buy 1 lease" at the overage rate).
  // Granted by the lease_credit_purchases ledger trigger; consumed atomically
  // by process_lease when the workspace is over its caps.
  purchasedLeaseCredits: number;
  // AI abstractions in the trailing 30 days — a live count mirroring
  // process_lease's assertProcessingQuota window. NOT the dead
  // workspaces.documents_used DB column (KNOWN_ISSUES #31).
  documentsUsed: number;
  timezone: string;
  defaultNotificationDays: number;
  createdAt: string;
  updatedAt: string;
  // Subscription state mirrored from Stripe via stripe-webhook. Null
  // for workspaces that haven't checked out yet (the workspace `plan`
  // column may be set optimistically in onboarding before payment).
  subscriptionStatus: string | null;
  billingInterval: 'monthly' | 'annual' | null;
  subscriptionPeriodEnd: string | null;
  // User-declared plan at workspace creation. Independent of `plan`
  // (which Stripe webhook owns). Used to recover an abandoned Business
  // checkout — AccountSettings surfaces a callout when intendedPlan
  // diverges from plan.
  intendedPlan: SubscriptionPlan | null;
  // Cancellation lifecycle (2026-06-12, billing-system-owned): canceledAt
  // set = subscription fully ended, workspace is in the 30-day read-only
  // grace window ending at graceExpiresAt; softDeletedAt set = access
  // revoked, purge scheduled ~10 days out. All null = normal.
  canceledAt: string | null;
  graceExpiresAt: string | null;
  softDeletedAt: string | null;
  // Firm layer (Phase 9): when set, the workspace belongs to a firm; plan and
  // billing are governed at the firm level (the DB locks the plan), so the
  // Billing tab shows a read-only "managed by {firmName}" banner. null = standalone.
  firmId: string | null;
  firmName: string | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  user?: User;
  invitedEmail?: string;
  invitedAt?: string;
  acceptedAt?: string;
  joinedAt: string;
}

export interface Lease {
  id: string;
  workspaceId: string;
  type: LeaseType;
  parentLeaseId?: string; // For amendments
  status: LeaseStatus;
  documentUrl: string;
  documentName: string;
  
  // Core extracted data
  lessor?: string;
  lessee?: string;
  propertyAddress?: string;
  commencementDate?: string;
  expirationDate?: string;
  rentAmount?: number;
  rentFrequency?: 'monthly' | 'quarterly' | 'annually';
  
  intakeSource?: 'request_workflow' | 'email_intake' | 'backdoor' | 'manual_upload';

  // Confidence scores (AI)
  extractionConfidence?: number;
  
  // Audit
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
  finalizedBy?: string;
}

export interface RentRollEntry {
  id: string;
  leaseId: string;
  startDate: string;
  endDate: string;
  amount: number;
  escalationType?: 'percent' | 'index' | 'none';
  escalationValue?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  workspaceId: string;
  leaseId: string;
  type: 'renewal' | 'escalation' | 'expiration';
  title: string;
  message: string;
  scheduledFor: string;
  sentAt?: string;
  channels: ('email' | 'sms')[];
  status: 'scheduled' | 'sent' | 'failed';
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  userId: string;
  entityType: 'lease' | 'rent_roll' | 'notification' | 'integration' | 'workspace' | 'user';
  entityId: string;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface SecurityLogEntry {
  id: string;
  userId: string;
  eventType: 'login' | 'logout' | 'password_change' | 'integration_connect' | 'integration_disconnect' | 'session_terminate';
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
}

// Navigation types
export interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  requiresPlan?: SubscriptionPlan;
}

// Onboarding
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  completed: boolean;
  href?: string;
}

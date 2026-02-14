import type { ComponentProps } from 'react';
import { LeaseRequestForm } from './LeaseRequestForm';

type LeaseRequestFormProps = ComponentProps<typeof LeaseRequestForm>;

// Backward-compatible export name. Phase 2 replaces this drawer with LeaseRequestForm.
export function CreateLeaseDrawer(props: LeaseRequestFormProps) {
  return <LeaseRequestForm {...props} />;
}

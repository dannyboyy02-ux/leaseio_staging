# Operations docs

Per `docs/OPERATIONAL_MONITORING_SPEC.md` Phase 1 deliverables, this directory holds:

- **`PHASE_1_VERIFICATION_<date>.md`** — point-in-time verification report when Phase 1 hardening is reviewed
- **`registrar-state-<date>.md`** — captured state of the domain registrar (auto-renew status, card validity, 2FA, contact email)
- **`screenshots/`** — vendor configuration screenshots required by Phase 1 (Anthropic spending cap, etc.)
- **`backup-restore-runbook.md`** — Phase 3 deliverable; how to restore a Supabase backup to staging

These are intentionally low-tech operator documents. They exist so future-Daniel (or a successor) can reconstruct what state the LeaseIO operational stack was in on a given date without having to re-derive it from vendor dashboards.

Updates are append-only by date. Old verification reports are kept; do not overwrite. The latest one is the current truth.

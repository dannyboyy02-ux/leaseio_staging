# Registrar state — TEMPLATE

**Copy this file to `registrar-state-<date>.md` and fill in. Do not commit this template with values; it's the blank form.**

---

**Captured:** YYYY-MM-DD
**Captured by:** <your name>
**Registrar:** <Namecheap | Cloudflare | GoDaddy | other>

## Domain: theleaseio.com

| Setting | Required | Actual | Notes |
|---|---|---|---|
| Auto-renew | ON | <ON / OFF> | |
| Card on file | Valid 12+ months past renewal | Last 4 digits: <####>, exp <MM/YYYY> | Card expires before next renewal? Add to vendor_renewal_calendar |
| Renewal-notice email | Active mailbox Daniel monitors | <email> | Not a forwarded alias. Verify by sending test email to it. |
| 2FA on registrar account | ON | <ON / OFF / method> | TOTP app, hardware key, or SMS — note which |
| Domain locking / transfer protection | ON | <ON / OFF> | Some registrars call this "Registrar Lock" or "Domain Lock" |
| Auth/EPP code accessible | Yes | <Yes / No> | Required if domain ever needs to transfer; should be retrievable via the registrar dashboard |
| WHOIS privacy | ON | <ON / OFF> | Recommended, hides personal contact info from public WHOIS |
| Recovery codes for 2FA stored | Password manager | <where> | Critical: 2FA recovery codes must be stored independently of the primary 2FA device |

## Next renewal

- **Renewal date:** YYYY-MM-DD
- **Estimated cost:** $XX.XX
- **Auto-renew expected to fire:** YYYY-MM-DD (typically 1-30 days before renewal date)

## Action items from this capture

- [ ] If auto-renew is OFF, turn it ON immediately
- [ ] If card expires before renewal date, update card NOW (do not wait for the renewal email)
- [ ] If 2FA is OFF, enable it (preferably TOTP, not SMS)
- [ ] Add card-expiration date as a row in the upcoming `vendor_renewal_calendar` table (Phase 2 of monitoring spec) — for now, add to the manual Google Calendar
- [ ] If renewal-notice email is a forwarded alias, change it to a directly-monitored mailbox

## Notes

<free-form: anything weird, anything you want future-Daniel to know>

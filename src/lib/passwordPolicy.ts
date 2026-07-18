// Canonical client-side password policy.
//
// Mirrors the server-side isStrongPassword() gate in
// supabase/functions/accept-invite/index.ts — any change here must be
// mirrored there (a static drift-pin test in passwordPolicy.test.ts enforces
// the pairing). labelKeys live under accept_invite.password_req.* for
// historical reasons (the checklist shipped on AcceptInvite first); they are
// shared by Signup / ResetPassword / AcceptInvite.

export interface PasswordRequirement {
  id: 'min_length' | 'uppercase' | 'lowercase' | 'number';
  labelKey: string;
  met: (pw: string) => boolean;
}

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { id: 'min_length', labelKey: 'accept_invite.password_req.min_length', met: (pw) => pw.length >= 8 },
  { id: 'uppercase', labelKey: 'accept_invite.password_req.uppercase', met: (pw) => /[A-Z]/.test(pw) },
  { id: 'lowercase', labelKey: 'accept_invite.password_req.lowercase', met: (pw) => /[a-z]/.test(pw) },
  { id: 'number', labelKey: 'accept_invite.password_req.number', met: (pw) => /[0-9]/.test(pw) },
];

export function isPasswordValid(pw: string): boolean {
  return PASSWORD_REQUIREMENTS.every((r) => r.met(pw));
}

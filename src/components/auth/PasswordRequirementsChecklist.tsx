import { Check, X } from 'lucide-react';
import { useAppTranslation } from '@/hooks/useAppTranslation';
import { PASSWORD_REQUIREMENTS } from '@/lib/passwordPolicy';

// Shared live password-requirements checklist (extracted from AcceptInvite's
// inline version). Purely presentational — consumers gate submission
// themselves via isPasswordValid() from '@/lib/passwordPolicy'.
export function PasswordRequirementsChecklist({ password }: { password: string }) {
  const { t } = useAppTranslation();

  return (
    <ul className="space-y-1 text-xs px-1">
      {PASSWORD_REQUIREMENTS.map((req) => {
        const met = req.met(password);
        return (
          <li key={req.id} className={`flex items-center gap-1.5 ${met ? 'text-green-600' : 'text-muted-foreground'}`}>
            {met
              ? <Check className="h-3 w-3 shrink-0" />
              : <X className="h-3 w-3 shrink-0" />}
            {t(req.labelKey)}
          </li>
        );
      })}
    </ul>
  );
}

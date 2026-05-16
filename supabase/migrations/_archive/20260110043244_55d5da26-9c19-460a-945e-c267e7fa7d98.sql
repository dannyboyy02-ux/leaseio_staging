-- Add confirmed_sections to leases table for persisting section confirmations
ALTER TABLE public.leases 
ADD COLUMN confirmed_sections text[] NOT NULL DEFAULT '{}';

-- Add notification preferences to profiles table
ALTER TABLE public.profiles 
ADD COLUMN email_notifications_enabled boolean NOT NULL DEFAULT true,
ADD COLUMN sms_notifications_enabled boolean NOT NULL DEFAULT false;

-- Create invite_tokens table for pending workspace invitations
CREATE TABLE public.invite_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
    email text NOT NULL,
    role public.workspace_role NOT NULL DEFAULT 'viewer',
    token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '7 days'),
    accepted_at timestamp with time zone
);

-- Enable RLS on invite_tokens
ALTER TABLE public.invite_tokens ENABLE ROW LEVEL SECURITY;

-- Workspace owners can manage invites
CREATE POLICY "Owners can view workspace invites"
ON public.invite_tokens
FOR SELECT
USING (is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "Owners can create workspace invites"
ON public.invite_tokens
FOR INSERT
WITH CHECK (is_workspace_owner(workspace_id, auth.uid()));

CREATE POLICY "Owners can delete workspace invites"
ON public.invite_tokens
FOR DELETE
USING (is_workspace_owner(workspace_id, auth.uid()));

-- Users can view their own pending invites (by email)
CREATE POLICY "Users can view invites sent to them"
ON public.invite_tokens
FOR SELECT
USING (email = (SELECT email FROM auth.users WHERE id = auth.uid()));
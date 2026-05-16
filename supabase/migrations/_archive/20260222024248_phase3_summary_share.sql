-- Phase 3: Financial Impact Summary — shareable token fields + view tracking

-- Add share token fields to leases
ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS summary_share_token text UNIQUE,
  ADD COLUMN IF NOT EXISTS summary_shared_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary_last_viewed_at timestamptz;

-- Table to track public views of shared summaries
CREATE TABLE IF NOT EXISTS public.summary_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES public.leases(id) ON DELETE CASCADE,
  viewed_at timestamptz DEFAULT now(),
  viewer_ip text,
  referrer text
);

-- Index for fast view count lookups per lease
CREATE INDEX IF NOT EXISTS summary_views_lease_id_idx
  ON public.summary_views (lease_id);

-- RLS: only service role can insert/select (public endpoint uses service key)
ALTER TABLE public.summary_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON public.summary_views
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

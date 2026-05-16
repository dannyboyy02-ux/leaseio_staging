-- Enable required extensions for cron scheduling
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Schedule the notification function to run every day at 8 AM UTC
SELECT cron.schedule(
  'send-lease-notifications-daily',
  '0 8 * * *',
  $$
  SELECT
    net.http_post(
      url:='https://wwkwoxxcprnjjufkbzac.supabase.co/functions/v1/send-lease-notifications',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3a3dveHhjcHJuamp1ZmtiemFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjczMjIzNzAsImV4cCI6MjA4Mjg5ODM3MH0.6ymyHJ5yDoLxnEHupdhcLUnile__H8HxN3bZ5x77jto"}'::jsonb,
      body:='{}'::jsonb
    ) AS request_id;
  $$
);
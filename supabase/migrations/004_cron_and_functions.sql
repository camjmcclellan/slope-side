-- Migration: Enable pg_cron + pg_net for Edge Function scheduling,
-- add send_auto_response to jobs.job_type, and create cron schedules.

-- 1. Enable extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2. Update jobs.job_type CHECK to include send_auto_response
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_job_type_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_job_type_check
  CHECK (job_type IN (
    'send_email', 'check_replies', 'classify_reply',
    'send_auto_response', 'book_meeting', 'daily_orchestrator'
  ));

-- 3. Cron schedules — replace REPLACE_WITH_CRON_SECRET with your actual secret
SELECT cron.schedule(
  'enqueue-due-emails',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xffzwhisocyimeyxnrtr.supabase.co/functions/v1/enqueue-due-emails',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer REPLACE_WITH_CRON_SECRET"}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'process-jobs',
  '*/2 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xffzwhisocyimeyxnrtr.supabase.co/functions/v1/process-jobs',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer REPLACE_WITH_CRON_SECRET"}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'check-replies',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xffzwhisocyimeyxnrtr.supabase.co/functions/v1/check-replies',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer REPLACE_WITH_CRON_SECRET"}'::jsonb
  );
  $$
);

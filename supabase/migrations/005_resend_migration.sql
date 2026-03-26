-- Migration: Switch sending from Gmail API to Resend.
-- Gmail is still used read-only for reply detection.

-- 1. Add resend_id to emails table for tracking Resend's email ID on outbound
ALTER TABLE public.emails ADD COLUMN resend_id text;
CREATE INDEX idx_emails_resend_id ON public.emails (resend_id);

-- 2. Update email_accounts provider CHECK to include resend
ALTER TABLE public.email_accounts DROP CONSTRAINT IF EXISTS email_accounts_provider_check;
ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_provider_check
  CHECK (provider IN ('gmail', 'resend', 'outlook', 'smtp'));

-- 3. Add reply_to_email so Resend sends can route replies to a monitored inbox
ALTER TABLE public.email_accounts ADD COLUMN reply_to_email text;

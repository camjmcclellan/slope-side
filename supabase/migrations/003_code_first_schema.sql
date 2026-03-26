-- Migration: Code-first execution layer
-- Removes dependency on n8n by adding tables for email tracking,
-- sender configuration, and job scheduling directly in Postgres.

-- 1. email_accounts — sender configuration (replaces hardcoded sender_name)
CREATE TABLE public.email_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  provider text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail', 'outlook', 'smtp')),
  daily_send_limit int NOT NULL DEFAULT 50,
  sent_today int NOT NULL DEFAULT 0,
  sent_today_reset_at timestamptz DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'suspended')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_email_accounts_status ON public.email_accounts (status);

CREATE TRIGGER trg_email_accounts_updated_at
  BEFORE UPDATE ON public.email_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 2. emails — tracks every sent/received email with Gmail IDs for reply correlation
CREATE TABLE public.emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  email_account_id uuid REFERENCES public.email_accounts(id) ON DELETE SET NULL,
  sequence_id uuid REFERENCES public.sequences(id) ON DELETE SET NULL,
  step_number int,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  gmail_message_id text UNIQUE,
  gmail_thread_id text,
  from_email text NOT NULL,
  to_email text NOT NULL,
  subject text,
  body_text text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_emails_lead ON public.emails (lead_id);
CREATE INDEX idx_emails_gmail_thread ON public.emails (gmail_thread_id);
CREATE INDEX idx_emails_lead_direction ON public.emails (lead_id, direction);
CREATE INDEX idx_emails_sent_at ON public.emails (sent_at);

-- 3. jobs — task queue replacing n8n scheduling
CREATE TABLE public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL CHECK (job_type IN (
    'send_email', 'check_replies', 'classify_reply',
    'book_meeting', 'daily_orchestrator'
  )),
  payload jsonb DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'completed', 'failed', 'cancelled'
  )),
  priority int NOT NULL DEFAULT 0,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by text,
  completed_at timestamptz,
  error text,
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 3,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_jobs_pending ON public.jobs (scheduled_for, priority DESC)
  WHERE status = 'pending';
CREATE INDEX idx_jobs_type ON public.jobs (job_type);
CREATE INDEX idx_jobs_status ON public.jobs (status);

-- 4. Modify lead_sequence_state — add concurrency lock
ALTER TABLE public.lead_sequence_state
  ADD COLUMN locked_until timestamptz;

-- 5. Modify events — add FK to emails table
ALTER TABLE public.events
  ADD COLUMN email_id uuid REFERENCES public.emails(id) ON DELETE SET NULL;

CREATE INDEX idx_events_email ON public.events (email_id);

-- 6. Modify sequence_steps — add channel for future multi-channel support
ALTER TABLE public.sequence_steps
  ADD COLUMN channel text NOT NULL DEFAULT 'email'
    CHECK (channel IN ('email', 'linkedin', 'phone', 'manual'));

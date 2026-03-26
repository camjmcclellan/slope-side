-- Slope-Side: Cold Email Automation Schema
-- Applied to Supabase project: xffzwhisocyimeyxnrtr (slope-side)

-- 1. leads
CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name text NOT NULL,
  last_name text,
  email text UNIQUE NOT NULL,
  company text,
  title text,
  industry text,
  company_size text,
  linkedin_url text,
  custom_fields jsonb DEFAULT '{}',
  status text DEFAULT 'new' CHECK (status IN ('new','active','replied','interested','meeting_booked','not_interested','bounced','unsubscribed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_leads_email ON public.leads (email);
CREATE INDEX idx_leads_status ON public.leads (status);

-- 2. sequences
CREATE TABLE public.sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  goal text,
  status text DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 3. sequence_steps
CREATE TABLE public.sequence_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  step_number int NOT NULL,
  delay_days int DEFAULT 0,
  subject_template text,
  body_template text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (sequence_id, step_number)
);

CREATE INDEX idx_sequence_steps_sequence ON public.sequence_steps (sequence_id);

-- 4. lead_sequence_state
CREATE TABLE public.lead_sequence_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES public.sequences(id) ON DELETE CASCADE,
  current_step_number int DEFAULT 1,
  status text DEFAULT 'active' CHECK (status IN ('active','completed','paused','replied','opted_out')),
  next_action_at timestamptz,
  enrolled_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (lead_id, sequence_id)
);

CREATE INDEX idx_lead_sequence_state_next_action ON public.lead_sequence_state (next_action_at) WHERE status = 'active';
CREATE INDEX idx_lead_sequence_state_lead ON public.lead_sequence_state (lead_id);

-- 5. events
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  sequence_id uuid REFERENCES public.sequences(id) ON DELETE SET NULL,
  step_number int,
  event_type text NOT NULL CHECK (event_type IN ('email_sent','email_replied','reply_classified','auto_response_sent','meeting_booked','bounced')),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_events_lead ON public.events (lead_id);
CREATE INDEX idx_events_type ON public.events (event_type);
CREATE INDEX idx_events_created ON public.events (created_at);

-- 6. orchestrator_logs
CREATE TABLE public.orchestrator_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL,
  metrics_snapshot jsonb,
  actions_taken jsonb,
  reasoning text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_orchestrator_logs_date ON public.orchestrator_logs (run_date);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER trg_sequences_updated_at BEFORE UPDATE ON public.sequences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER trg_sequence_steps_updated_at BEFORE UPDATE ON public.sequence_steps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER trg_lead_sequence_state_updated_at BEFORE UPDATE ON public.lead_sequence_state FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

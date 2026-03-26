# Slope-Side: Autonomous Cold Email Sales Framework

Database-driven cold email automation system with an AI orchestrator that optimizes sequences daily. Built for [ScaleMe](https://scaleme.ai/) — affordable offshore staffing for US businesses.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    Orchestrator Agent (Daily)                 │
│  Pulls metrics → Analyzes performance → Adjusts sequences    │
└──────────────────────┬───────────────────────────────────────┘
                       │ reads/writes
┌──────────────────────▼───────────────────────────────────────┐
│                  Supabase (Source of Truth)                   │
│  leads │ sequences │ sequence_steps │ lead_sequence_state    │
│  email_accounts │ emails │ jobs │ events │ orchestrator_logs │
└──────────────────────▲───────────────────────────────────────┘
                       │ queries/updates
┌──────────────────────┴───────────────────────────────────────┐
│              Supabase Edge Functions + pg_cron                │
│  enqueue-due-emails (*/5 min) — find leads due, create jobs  │
│  process-jobs      (*/2 min) — send via Resend, classify     │
│  check-replies     (*/5 min) — poll Gmail inbox for replies   │
└──────────────────────────────────────────────────────────────┘
         │                                      │
    Resend API                           Gmail API (read-only)
    (sending)                            (reply detection)
```

## Components

### Database (Supabase)
- **Supabase Project:** `xffzwhisocyimeyxnrtr` (slope-side)
- Schema in `supabase/migrations/`

| Table | Purpose |
|-------|---------|
| `leads` | Prospect contact info and status |
| `sequences` | Email sequence definitions |
| `sequence_steps` | Templates, timing, and channel per step |
| `lead_sequence_state` | Where each lead is in their sequence + concurrency lock |
| `email_accounts` | Sender email config, rate limits, and `reply_to_email` |
| `emails` | Every sent/received email with `resend_id` (outbound) and `gmail_message_id` (inbound) |
| `jobs` | Task queue for all async work (send, check, classify, book) |
| `events` | Immutable log of all actions (sends, replies, meetings) |
| `orchestrator_logs` | Daily decision log from the orchestrator agent |

### Edge Functions

All 3 functions are deployed on Supabase and triggered by pg_cron:

| Function | Schedule | What it does |
|----------|----------|-------------|
| `enqueue-due-emails` | Every 5 min | Queries `lead_sequence_state` for leads due for their next email, locks them, creates `send_email` jobs |
| `process-jobs` | Every 2 min | Claims pending jobs and executes: sends emails via **Resend API**, classifies replies via OpenAI, sends auto-responses to interested leads |
| `check-replies` | Every 5 min | Polls **Gmail** (read-only) for unread messages, matches sender against known lead emails, stores inbound replies, creates `classify_reply` jobs |

Source code in `supabase/functions/`.

### Orchestrator Agent
- System prompt: `orchestrator/SYSTEM_PROMPT.md`
- SQL queries: `orchestrator/queries/`
- Cursor rule: `.cursor/rules/orchestrator.mdc`

Run the orchestrator by opening a new Cursor agent chat and referencing the orchestrator rule, or by invoking it as a Claude background task.

## Setup

### 1. Resend (Email Sending)

Resend handles all outbound email. No OAuth complexity — just an API key.

1. Sign up at [resend.com](https://resend.com)
2. **Verify your sending domain** (e.g. `scaleme.ai`) under Domains
   - Add the DNS records Resend provides (DKIM, SPF, DMARC)
   - Without a verified domain you can only send from `onboarding@resend.dev` (testing only)
3. Create an **API key** under API Keys

### 2. Gmail (Reply Detection — Read Only)

Gmail is used **only** to read inbound replies. The `check-replies` function polls your inbox for messages from known leads.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing)
3. Enable the **Gmail API** under APIs & Services
4. Create **OAuth 2.0 credentials** (Desktop app type)
5. Run the OAuth consent flow to get a **refresh token**
   - Only scope needed: `https://www.googleapis.com/auth/gmail.readonly`
6. The `reply_to_email` field on `email_accounts` should be your Gmail address so replies land there

### 3. Set Edge Function Secrets

In the Supabase Dashboard under Edge Functions > Secrets (or via CLI), set:

```
RESEND_API_KEY=re_your_resend_api_key
GMAIL_CLIENT_ID=your-google-client-id
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REFRESH_TOKEN=your-gmail-refresh-token
OPENAI_API_KEY=your-openai-api-key
CRON_SECRET=any-random-secret-string
```

Then update the pg_cron schedules to use your `CRON_SECRET`:

```sql
-- Run in Supabase SQL Editor for each job:
SELECT cron.unschedule('enqueue-due-emails');
SELECT cron.schedule('enqueue-due-emails', '*/5 * * * *', $$
  SELECT net.http_post(
    url := 'https://xffzwhisocyimeyxnrtr.supabase.co/functions/v1/enqueue-due-emails',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb
  );
$$);
-- Repeat for process-jobs (*/2 * * * *) and check-replies (*/5 * * * *)
```

### 4. Add an Email Account

```sql
INSERT INTO email_accounts (email, display_name, provider, daily_send_limit, reply_to_email)
VALUES ('cameron@scaleme.ai', 'Cameron', 'resend', 50, 'cameron@gmail.com');
```

- `email`: Your Resend-verified sending address (e.g. `cameron@scaleme.ai`)
- `reply_to_email`: Your Gmail address where replies will land
- `provider`: Set to `'resend'`

### 5. Add Leads

Give the orchestrator agent a batch of leads and it will insert + enroll them. Or do it directly:
```sql
INSERT INTO leads (first_name, last_name, email, company, title)
VALUES
  ('Jane', 'Smith', 'jane@acme.com', 'Acme Inc', 'CEO'),
  ('Bob', 'Jones', 'bob@widgets.co', 'Widgets Co', 'COO')
ON CONFLICT (email) DO NOTHING;

INSERT INTO lead_sequence_state (lead_id, sequence_id, current_step_number, next_action_at)
SELECT l.id, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 1, NOW()
FROM leads l
WHERE l.email IN ('jane@acme.com', 'bob@widgets.co')
  AND NOT EXISTS (
    SELECT 1 FROM lead_sequence_state lss
    WHERE lss.lead_id = l.id
      AND lss.sequence_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  );
```

### 6. Run the Orchestrator

Each morning, start an agent chat in Cursor with the orchestrator context. It will pull metrics, analyze performance, and suggest/make optimizations.

## How It Works

### Email Sending Flow
1. pg_cron triggers `enqueue-due-emails` every 5 minutes
2. It finds leads with `next_action_at <= NOW()`, locks them, and creates `send_email` jobs
3. pg_cron triggers `process-jobs` every 2 minutes
4. It claims pending `send_email` jobs, resolves templates, sends via **Resend API**
5. After sending, it logs the email (with `resend_id`), records the event, and advances the lead to the next step (or marks complete)

### Reply Detection Flow
1. pg_cron triggers `check-replies` every 5 minutes
2. It polls **Gmail** (read-only) for recent unread messages
3. Matches sender email addresses against known leads in the database
4. For matches: stores the inbound email (with `gmail_message_id`), pauses the sequence, creates a `classify_reply` job
5. `process-jobs` picks up the classify job, calls OpenAI GPT-4o-mini to classify the reply
6. If "interested": sends an auto-response via Resend asking to book a meeting
7. If "unsubscribe": opts the lead out of all sequences

### Rate Limiting
- `email_accounts.daily_send_limit` caps sends per day (default 50)
- `email_accounts.sent_today` counter resets daily
- `lead_sequence_state.locked_until` prevents double-sends

## Email Sequence (Default)

| Step | Delay | Subject | Angle |
|------|-------|---------|-------|
| 1 | Immediate | Quick question about scaling {{company}} | Introduction + value prop |
| 2 | +3 days | Re: Quick question about scaling {{company}} | Cost savings proof point |
| 3 | +4 days | Last note from me, {{first_name}} | Break-up, leave door open |

The orchestrator adjusts templates and timing based on performance data.

## Template Placeholders

| Placeholder | Source |
|-------------|--------|
| `{{first_name}}` | `leads.first_name` |
| `{{last_name}}` | `leads.last_name` |
| `{{company}}` | `leads.company` |
| `{{title}}` | `leads.title` |
| `{{industry}}` | `leads.industry` |
| `{{company_size}}` | `leads.company_size` |
| `{{sender_name}}` | `email_accounts.display_name` |

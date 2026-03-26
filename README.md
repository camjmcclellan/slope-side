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
│                 Code Execution Layer                          │
│  Job Runner: polls `jobs` table, executes pending tasks      │
│  - send_email: resolve templates → send via Gmail API → log  │
│  - check_replies: poll Gmail → match threads → store inbound │
│  - classify_reply: AI classification → update lead status    │
│  - book_meeting: Google Calendar create → log event          │
└──────────────────────────────────────────────────────────────┘
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
| `email_accounts` | Sender email configuration and daily rate limits |
| `emails` | Every sent/received email with Gmail message/thread IDs |
| `jobs` | Task queue for all async work (send, check, classify, book) |
| `events` | Immutable log of all actions (sends, replies, meetings) |
| `orchestrator_logs` | Daily decision log from the orchestrator agent |

### Orchestrator Agent
- System prompt: `orchestrator/SYSTEM_PROMPT.md`
- SQL queries: `orchestrator/queries/`
- Cursor rule: `.cursor/rules/orchestrator.mdc`

Run the orchestrator by opening a new Cursor agent chat and referencing the orchestrator rule, or by invoking it as a Claude background task.

## Setup

### 1. Add an Email Account
```sql
INSERT INTO email_accounts (email, display_name, provider, daily_send_limit)
VALUES ('cameron@scaleme.ai', 'Cameron', 'gmail', 50);
```

### 2. Add Leads
Use the orchestrator agent or insert directly:
```sql
INSERT INTO leads (first_name, last_name, email, company, title)
VALUES ('Jane', 'Smith', 'jane@acme.com', 'Acme Inc', 'CEO');

INSERT INTO lead_sequence_state (lead_id, sequence_id, next_action_at)
VALUES (
  (SELECT id FROM leads WHERE email = 'jane@acme.com'),
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  NOW()
);
```

### 3. Run the Orchestrator
Each morning, start an agent chat in Cursor with the orchestrator context. It will pull metrics, analyze performance, and suggest/make optimizations.

## How the Job Queue Works

The `jobs` table is the central dispatch for all async work:

1. **Enqueue** — Insert a row with `job_type`, `payload`, and `scheduled_for`
2. **Claim** — A worker atomically claims a job: `UPDATE jobs SET status = 'claimed', claimed_at = NOW(), claimed_by = 'worker-id' WHERE id = ... AND status = 'pending'`
3. **Execute** — Worker runs the task (send email, classify reply, etc.)
4. **Complete/Fail** — Worker updates status to `completed` or `failed` (with error + retry_count)

The `lead_sequence_state.locked_until` column prevents double-sends when multiple workers overlap.

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

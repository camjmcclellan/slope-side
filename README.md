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
│  events │ orchestrator_logs                                  │
└──────────────────────▲───────────────────────────────────────┘
                       │ queries/updates
┌──────────────────────┴───────────────────────────────────────┐
│                   n8n Execution Layer                         │
│  WF1: Cold Email Sender (every 15 min)                       │
│  WF2: Reply Watcher + Auto-Responder (Gmail trigger)         │
│  WF3: Meeting Booker (webhook)                               │
└──────────────────────────────────────────────────────────────┘
```

## Components

### Database (Supabase)
- **Supabase Project:** `ibfphozcyhxyvxhydagl` (baylor)
- Schema in `supabase/migrations/001_initial_schema.sql`
- Seed data in `supabase/migrations/002_seed_scaleme_sequence.sql`

### n8n Workflows
All workflows live on [n8n cloud](https://slope-side.app.n8n.cloud):

| Workflow | ID | Trigger | What it does |
|----------|-----|---------|-------------|
| Cold Email Sender | `A8WAvmL3Xjr6bdea` | Schedule (15 min) | Queries due leads, resolves templates, sends via Gmail |
| Reply Watcher | `jVMwW9P3zxcg9SBX` | Gmail Trigger | Classifies replies with AI, auto-responds to interested leads |
| Meeting Booker | `L7eI0SOEthBBh67E` | Webhook POST | Creates Google Calendar events for confirmed meetings |

SDK source code in `n8n/workflows/`.

### Orchestrator Agent
- System prompt: `orchestrator/SYSTEM_PROMPT.md`
- SQL queries: `orchestrator/queries/`
- Cursor rule: `.cursor/rules/orchestrator.mdc`

Run the orchestrator by opening a new Cursor agent chat and referencing the orchestrator rule, or by invoking it as a Claude background task.

## Setup

### 1. Configure n8n Credentials
Each workflow needs credentials configured in the n8n UI:
- **Supabase Postgres** — connection string to your Supabase database
- **Gmail OAuth2** — Google account for sending/receiving emails
- **OpenAI API** — for reply classification (Workflow 2)
- **Google Calendar OAuth2** — for calendar availability (Workflows 2 & 3)

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

### 3. Activate Workflows
In n8n, toggle each workflow to active. The Cold Email Sender will start processing leads whose `next_action_at` has passed.

### 4. Run the Orchestrator
Each morning, start an agent chat in Cursor with the orchestrator context. It will pull metrics, analyze performance, and suggest/make optimizations.

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
| `{{sender_name}}` | Hardcoded in Code node (default: "Cameron") |

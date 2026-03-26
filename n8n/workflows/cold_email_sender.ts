import { workflow, node, trigger, expr, newCredential, sticky } from '@n8n/workflow-sdk';

const scheduleTrigger = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.3,
  config: {
    name: 'Every 15 Minutes',
    parameters: {
      rule: {
        interval: [{ field: 'minutes', minutesInterval: 15 }]
      }
    },
    position: [240, 300]
  },
  output: [{}]
});

const queryDueLeads = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Query Due Leads',
    parameters: {
      operation: 'executeQuery',
      query: "SELECT l.id as lead_id, l.first_name, l.last_name, l.email, l.company, " +
        "l.title, l.industry, l.company_size, " +
        "lss.id as state_id, lss.sequence_id, lss.current_step_number, " +
        "ss.subject_template, ss.body_template, " +
        "(SELECT ss2.delay_days FROM sequence_steps ss2 " +
        "WHERE ss2.sequence_id = lss.sequence_id " +
        "AND ss2.step_number = lss.current_step_number + 1) as next_delay_days, " +
        "(SELECT COUNT(*)::int FROM sequence_steps ss3 " +
        "WHERE ss3.sequence_id = lss.sequence_id) as total_steps " +
        "FROM lead_sequence_state lss " +
        "JOIN leads l ON l.id = lss.lead_id " +
        "JOIN sequence_steps ss ON ss.sequence_id = lss.sequence_id " +
        "AND ss.step_number = lss.current_step_number " +
        "JOIN sequences s ON s.id = lss.sequence_id AND s.status = 'active' " +
        "WHERE lss.status = 'active' AND lss.next_action_at <= NOW() " +
        "LIMIT 20",
      options: {}
    },
    credentials: { postgres: newCredential('Supabase Postgres') },
    position: [480, 300]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', last_name: 'Doe',
    email: 'john@example.com', company: 'Acme Inc', title: 'CEO',
    subject_template: 'Quick question about {{company}}',
    body_template: 'Hi {{first_name}}...', state_id: 'def-456',
    sequence_id: 'ghi-789', current_step_number: 1,
    next_delay_days: 3, total_steps: 3
  }]
});

const replacePlaceholders = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Replace Placeholders',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode:
        'const item = $input.item.json;\n' +
        'const replacements = {\n' +
        '  "{{first_name}}": item.first_name || "",\n' +
        '  "{{last_name}}": item.last_name || "",\n' +
        '  "{{company}}": item.company || "",\n' +
        '  "{{title}}": item.title || "",\n' +
        '  "{{industry}}": item.industry || "",\n' +
        '  "{{company_size}}": item.company_size || "",\n' +
        '  "{{sender_name}}": "Cameron"\n' +
        '};\n' +
        'let subject = item.subject_template || "";\n' +
        'let body = item.body_template || "";\n' +
        'for (const [ph, val] of Object.entries(replacements)) {\n' +
        '  subject = subject.split(ph).join(val);\n' +
        '  body = body.split(ph).join(val);\n' +
        '}\n' +
        'return { ...item, resolved_subject: subject, resolved_body: body };'
    },
    position: [720, 300]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', email: 'john@example.com',
    company: 'Acme Inc', resolved_subject: 'Quick question about Acme Inc',
    resolved_body: 'Hi John...', state_id: 'def-456',
    sequence_id: 'ghi-789', current_step_number: 1,
    next_delay_days: 3, total_steps: 3
  }]
});

const sendEmail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: 'Send Cold Email',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: expr('{{ $json.email }}'),
      subject: expr('{{ $json.resolved_subject }}'),
      emailType: 'html',
      message: expr('{{ $json.resolved_body.split("\\n").join("<br>") }}'),
      options: {
        appendAttribution: false
      }
    },
    credentials: { gmailOAuth2: newCredential('Gmail') },
    position: [960, 300]
  },
  output: [{ id: 'msg-123', threadId: 'thread-123', labelIds: ['SENT'] }]
});

const consolidateData = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Post-Send Data',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode:
        'const emailData = $("Replace Placeholders").item.json;\n' +
        'const gmailResult = $input.item.json;\n' +
        'return {\n' +
        '  lead_id: emailData.lead_id,\n' +
        '  sequence_id: emailData.sequence_id,\n' +
        '  current_step_number: emailData.current_step_number,\n' +
        '  state_id: emailData.state_id,\n' +
        '  next_delay_days: emailData.next_delay_days || 1,\n' +
        '  total_steps: emailData.total_steps,\n' +
        '  gmail_id: gmailResult.id || "",\n' +
        '  gmail_thread_id: gmailResult.threadId || ""\n' +
        '};'
    },
    position: [1200, 300]
  },
  output: [{
    lead_id: 'abc-123', sequence_id: 'ghi-789',
    current_step_number: 1, state_id: 'def-456',
    next_delay_days: 3, total_steps: 3,
    gmail_id: 'msg-123', gmail_thread_id: 'thread-123'
  }]
});

const logEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Email Sent',
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO events (lead_id, sequence_id, step_number, event_type, metadata) " +
        "VALUES ($1::uuid, $2::uuid, $3::int, 'email_sent', " +
        "json_build_object('gmail_id', $4, 'gmail_thread_id', $5))",
      options: {
        queryReplacement: expr('{{ $json.lead_id }},{{ $json.sequence_id }},{{ $json.current_step_number }},{{ $json.gmail_id }},{{ $json.gmail_thread_id }}')
      }
    },
    credentials: { postgres: newCredential('Supabase Postgres') },
    position: [1440, 300]
  },
  output: [{}]
});

const advanceState = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Advance Sequence State',
    parameters: {
      operation: 'executeQuery',
      query: "UPDATE lead_sequence_state SET " +
        "current_step_number = current_step_number + 1, " +
        "next_action_at = CASE WHEN $1::int >= $2::int THEN NULL " +
        "ELSE NOW() + (COALESCE($3, 1)::int || ' days')::interval END, " +
        "status = CASE WHEN $1::int >= $2::int THEN 'completed' ELSE 'active' END, " +
        "completed_at = CASE WHEN $1::int >= $2::int THEN NOW() ELSE completed_at END " +
        "WHERE id = $4::uuid; " +
        "UPDATE leads SET status = 'active' WHERE id = $5::uuid AND status = 'new';",
      options: {
        queryReplacement: expr('{{ $json.current_step_number }},{{ $json.total_steps }},{{ $json.next_delay_days }},{{ $json.state_id }},{{ $json.lead_id }}')
      }
    },
    credentials: { postgres: newCredential('Supabase Postgres') },
    position: [1680, 300]
  },
  output: [{}]
});

sticky(
  '## Cold Email Sender\n\n' +
  'Runs every 15 minutes. Queries leads whose next_action_at has passed, ' +
  'resolves email template placeholders, sends via Gmail, logs the event, ' +
  'and advances the sequence state.\n\n' +
  '**Rate limit:** Max 20 emails per run to stay under Gmail limits.\n\n' +
  '**Credentials needed:** Supabase Postgres, Gmail OAuth2',
  [scheduleTrigger, queryDueLeads],
  { color: 4 }
);

export default workflow('cold-email-sender', 'Slope-Side: Cold Email Sender')
  .add(scheduleTrigger)
  .to(queryDueLeads)
  .to(replacePlaceholders)
  .to(sendEmail)
  .to(consolidateData)
  .to(logEvent)
  .to(advanceState);

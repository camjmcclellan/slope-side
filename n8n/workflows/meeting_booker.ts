import { workflow, node, trigger, expr, sticky } from '@n8n/workflow-sdk';

const webhookTrigger = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Meeting Booking Webhook',
    parameters: {
      path: 'book-meeting',
      httpMethod: 'POST'
    },
    position: [240, 300]
  },
  output: [{
    body: {
      lead_email: 'john@example.com',
      meeting_datetime: '2026-03-28T14:00:00Z',
      duration_minutes: 30
    }
  }]
});

const lookupLead = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Lookup Lead',
    parameters: {
      operation: 'executeQuery',
      query: expr("SELECT l.id as lead_id, l.first_name, l.last_name, l.email, l.company, lss.sequence_id, lss.current_step_number FROM leads l LEFT JOIN lead_sequence_state lss ON lss.lead_id = l.id WHERE l.email = '{{ $json.body.lead_email }}'"),
      options: {}
    },
    position: [480, 300]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', last_name: 'Doe',
    email: 'john@example.com', company: 'Acme Inc',
    sequence_id: 'ghi-789', current_step_number: 2
  }]
});

const createEvent = node({
  type: 'n8n-nodes-base.googleCalendar',
  version: 1.3,
  config: {
    name: 'Create Calendar Event',
    parameters: {
      resource: 'event',
      operation: 'create',
      calendar: { __rl: true, mode: 'list', value: 'primary' },
      start: expr('{{ $("Meeting Booking Webhook").item.json.body.meeting_datetime }}'),
      end: expr('{{ DateTime.fromISO($("Meeting Booking Webhook").item.json.body.meeting_datetime).plus({ minutes: $("Meeting Booking Webhook").item.json.body.duration_minutes || 30 }).toISO() }}'),
      useDefaultReminders: true,
      additionalFields: {
        summary: expr('{{ "ScaleMe Discovery Call - " + $json.first_name + " " + $json.last_name + " (" + $json.company + ")" }}'),
        description: expr('{{ "Discovery call with " + $json.first_name + " " + $json.last_name + " from " + $json.company + " to discuss ScaleMe offshore staffing solutions." }}'),
        attendees: expr('{{ $json.email }}'),
        sendUpdates: 'all'
      }
    },
    position: [720, 300]
  },
  output: [{
    id: 'cal-event-1', summary: 'ScaleMe Discovery Call - John Doe (Acme Inc)',
    htmlLink: 'https://calendar.google.com/event?id=cal-event-1',
    start: { dateTime: '2026-03-28T14:00:00Z' },
    end: { dateTime: '2026-03-28T14:30:00Z' }
  }]
});

const logMeeting = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Meeting Booked',
    parameters: {
      operation: 'executeQuery',
      query: expr("INSERT INTO events (lead_id, sequence_id, step_number, event_type, metadata) VALUES ('{{ $(\"Lookup Lead\").item.json.lead_id }}'::uuid, '{{ $(\"Lookup Lead\").item.json.sequence_id }}'::uuid, {{ $(\"Lookup Lead\").item.json.current_step_number }}, 'meeting_booked', json_build_object('calendar_event_id', '{{ $json.id }}', 'calendar_link', '{{ $json.htmlLink }}')); UPDATE leads SET status = 'meeting_booked' WHERE id = '{{ $(\"Lookup Lead\").item.json.lead_id }}'::uuid;"),
      options: {}
    },
    position: [960, 300]
  },
  output: [{}]
});

sticky(
  '## Meeting Booker (Webhook)\\n\\nStandalone utility workflow. Call via POST to /webhook/book-meeting with:\\n```json\\n{ "lead_email": "...", "meeting_datetime": "ISO-8601", "duration_minutes": 30 }\\n```\\n\\nCreates a Google Calendar event with the lead as attendee, logs the meeting in the events table, and updates lead status to meeting_booked.\\n\\n**Setup:** Supabase Postgres, Google Calendar OAuth2',
  [webhookTrigger],
  { color: 6 }
);

export default workflow('meeting-booker', 'Slope-Side: Meeting Booker')
  .add(webhookTrigger)
  .to(lookupLead)
  .to(createEvent)
  .to(logMeeting);

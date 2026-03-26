import { workflow, node, trigger, expr, ifElse, languageModel, outputParser, sticky } from '@n8n/workflow-sdk';

const gmailTrigger = trigger({
  type: 'n8n-nodes-base.gmailTrigger',
  version: 1.3,
  config: {
    name: 'Watch for Replies',
    parameters: {
      pollTimes: { item: [{ mode: 'everyMinute' }] },
      event: 'messageReceived',
      simple: false,
      filters: {
        readStatus: 'unread',
        includeSpamTrash: false
      }
    },
    position: [240, 300]
  },
  output: [{
    id: 'msg-reply-1',
    threadId: 'thread-1',
    from: 'john@example.com',
    subject: 'Re: Quick question about Acme Inc',
    text: 'Hi Cameron, this sounds interesting. Would love to learn more.',
    date: '2026-03-26T10:00:00Z'
  }]
});

const matchLead = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Match Sender to Lead',
    parameters: {
      operation: 'executeQuery',
      query: expr("SELECT l.id as lead_id, l.first_name, l.last_name, l.email, l.company, l.status as lead_status, lss.id as state_id, lss.sequence_id, lss.current_step_number, lss.status as sequence_status FROM leads l LEFT JOIN lead_sequence_state lss ON lss.lead_id = l.id WHERE l.email = '{{ $json.from }}'"),
      options: {}
    },
    position: [480, 300]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', last_name: 'Doe',
    email: 'john@example.com', company: 'Acme Inc', lead_status: 'active',
    state_id: 'def-456', sequence_id: 'ghi-789',
    current_step_number: 1, sequence_status: 'active'
  }]
});

const checkLeadFound = ifElse({
  version: 2.3,
  config: {
    name: 'Lead Found?',
    parameters: {
      conditions: {
        conditions: [{
          leftValue: expr('{{ $json.lead_id }}'),
          operator: { type: 'string', operation: 'exists' },
          rightValue: ''
        }]
      }
    },
    position: [720, 300]
  }
});

const openAiModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  version: 1.3,
  config: {
    name: 'OpenAI Model',
    parameters: {
      model: { __rl: true, mode: 'list', value: 'gpt-4o-mini' },
      options: { temperature: 0.1 }
    },
    position: [960, 500]
  }
});

const classifyParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Classification Parser',
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: '{ "classification": "interested", "confidence": 0.95, "reasoning": "Lead expressed interest in learning more" }'
    },
    position: [1100, 500]
  }
});

const classifyReply = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'Classify Reply',
    parameters: {
      promptType: 'define',
      text: expr('Classify this email reply from a cold outreach lead.\\n\\nLead: {{ $json.first_name }} {{ $json.last_name }} at {{ $json.company }}\\nTheir reply: {{ $("Watch for Replies").item.json.text }}\\n\\nClassify as exactly one of: interested, not_interested, out_of_office, unsubscribe, other'),
      hasOutputParser: true,
      options: {
        systemMessage: 'You are a sales reply classifier. Classify cold email replies into one of these categories: interested (wants to learn more, asks questions, positive tone), not_interested (explicit no, not relevant, wrong person), out_of_office (auto-reply, OOO message), unsubscribe (asks to stop emails, remove from list), other (unclear or unrelated). Return your classification with confidence score and brief reasoning.'
      }
    },
    subnodes: {
      model: openAiModel,
      outputParser: classifyParser
    },
    position: [960, 300]
  },
  output: [{ output: '{"classification":"interested","confidence":0.95,"reasoning":"Lead expressed interest"}' }]
});

const parseClassification = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Classification Result',
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode: 'const aiOutput = $json.output;\\nconst leadData = $("Match Sender to Lead").item.json;\\nconst emailData = $("Watch for Replies").item.json;\\nlet parsed;\\ntry { parsed = typeof aiOutput === "string" ? JSON.parse(aiOutput) : aiOutput; } catch(e) { parsed = { classification: "other", confidence: 0, reasoning: "Failed to parse" }; }\\nreturn { ...leadData, ...parsed, reply_text: emailData.text, reply_subject: emailData.subject, reply_message_id: emailData.id, reply_thread_id: emailData.threadId };'
    },
    position: [1200, 300]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', company: 'Acme Inc',
    email: 'john@example.com', state_id: 'def-456', sequence_id: 'ghi-789',
    classification: 'interested', confidence: 0.95,
    reasoning: 'Lead expressed interest', reply_text: 'Sounds interesting',
    reply_message_id: 'msg-reply-1', reply_thread_id: 'thread-1'
  }]
});

const logReplyEvent = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Reply + Update Status',
    parameters: {
      operation: 'executeQuery',
      query: expr("INSERT INTO events (lead_id, sequence_id, step_number, event_type, metadata) VALUES ('{{ $json.lead_id }}'::uuid, '{{ $json.sequence_id }}'::uuid, {{ $json.current_step_number }}, 'email_replied', json_build_object('reply_text', '{{ $json.reply_text }}'));\\nINSERT INTO events (lead_id, sequence_id, step_number, event_type, metadata) VALUES ('{{ $json.lead_id }}'::uuid, '{{ $json.sequence_id }}'::uuid, {{ $json.current_step_number }}, 'reply_classified', json_build_object('classification', '{{ $json.classification }}', 'confidence', '{{ $json.confidence }}', 'reasoning', '{{ $json.reasoning }}'));\\nUPDATE lead_sequence_state SET status = 'replied' WHERE id = '{{ $json.state_id }}'::uuid;\\nUPDATE leads SET status = CASE WHEN '{{ $json.classification }}' = 'interested' THEN 'interested' WHEN '{{ $json.classification }}' = 'not_interested' THEN 'not_interested' WHEN '{{ $json.classification }}' = 'unsubscribe' THEN 'unsubscribed' ELSE 'replied' END WHERE id = '{{ $json.lead_id }}'::uuid;"),
      options: {}
    },
    position: [1440, 300]
  },
  output: [{}]
});

const checkInterested = ifElse({
  version: 2.3,
  config: {
    name: 'Is Interested?',
    parameters: {
      conditions: {
        conditions: [{
          leftValue: expr('{{ $("Parse Classification Result").item.json.classification }}'),
          operator: { type: 'string', operation: 'equals' },
          rightValue: 'interested'
        }]
      }
    },
    position: [1680, 300]
  }
});

const getCalendarEvents = node({
  type: 'n8n-nodes-base.googleCalendar',
  version: 1.3,
  config: {
    name: 'Get Calendar Availability',
    parameters: {
      resource: 'event',
      operation: 'getAll',
      calendar: { __rl: true, mode: 'list', value: 'primary' },
      returnAll: false,
      limit: 50,
      timeMin: expr('{{ $now.toISO() }}'),
      timeMax: expr('{{ $now.plus({ days: 5 }).toISO() }}'),
      options: {
        singleEvents: true,
        orderBy: 'startTime'
      }
    },
    position: [1920, 200]
  },
  output: [{
    id: 'evt1', summary: 'Team Meeting',
    start: { dateTime: '2026-03-27T10:00:00-05:00' },
    end: { dateTime: '2026-03-27T11:00:00-05:00' }
  }]
});

const findSlots = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Find Available Slots',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: 'const events = $input.all().map(i => i.json);\\nconst leadData = $("Parse Classification Result").first().json;\\nconst busySlots = events.filter(e => e.start && e.start.dateTime).map(e => ({\\n  start: new Date(e.start.dateTime),\\n  end: new Date(e.end.dateTime)\\n}));\\nconst slots = [];\\nconst now = new Date();\\nfor (let d = 1; d <= 5; d++) {\\n  const date = new Date(now);\\n  date.setDate(date.getDate() + d);\\n  if (date.getDay() === 0 || date.getDay() === 6) continue;\\n  for (const hour of [9, 11, 14, 16]) {\\n    const slotStart = new Date(date);\\n    slotStart.setHours(hour, 0, 0, 0);\\n    const slotEnd = new Date(slotStart);\\n    slotEnd.setMinutes(30);\\n    const busy = busySlots.some(b => slotStart < b.end && slotEnd > b.start);\\n    if (!busy && slots.length < 3) {\\n      slots.push(slotStart.toLocaleString(\"en-US\", { weekday: \"long\", month: \"short\", day: \"numeric\", hour: \"numeric\", minute: \"2-digit\", timeZoneName: \"short\" }));\\n    }\\n  }\\n}\\nif (slots.length === 0) slots.push(\"this week at a time that works for you\");\\nreturn [{ json: { ...leadData, available_slots: slots, slots_text: slots.join(\", \") } }];'
    },
    position: [2160, 200]
  },
  output: [{
    lead_id: 'abc-123', first_name: 'John', company: 'Acme Inc',
    email: 'john@example.com', reply_message_id: 'msg-reply-1',
    available_slots: ['Monday, Mar 30, 9:00 AM EST'],
    slots_text: 'Monday, Mar 30, 9:00 AM EST'
  }]
});

const sendAutoResponse = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: 'Send Auto-Response',
    parameters: {
      resource: 'message',
      operation: 'reply',
      messageId: expr('{{ $json.reply_message_id }}'),
      emailType: 'html',
      message: expr('{{ "Hi " + $json.first_name + ",<br><br>Great to hear from you! I\\'d love to set up a quick 15-minute call to walk you through how ScaleMe works and see if it\\'s a fit for " + $json.company + ".<br><br>I have availability at:<br>- " + $json.available_slots.join("<br>- ") + "<br><br>Would any of those work for you? If not, just let me know what times are best on your end.<br><br>Looking forward to it!<br>Cameron" }}'),
      options: {
        appendAttribution: false
      }
    },
    position: [2400, 200]
  },
  output: [{ id: 'reply-msg-1', threadId: 'thread-1' }]
});

const logAutoResponse = node({
  type: 'n8n-nodes-base.postgres',
  version: 2.6,
  config: {
    name: 'Log Auto-Response Sent',
    parameters: {
      operation: 'executeQuery',
      query: expr("INSERT INTO events (lead_id, sequence_id, step_number, event_type, metadata) VALUES ('{{ $(\"Parse Classification Result\").item.json.lead_id }}'::uuid, '{{ $(\"Parse Classification Result\").item.json.sequence_id }}'::uuid, {{ $(\"Parse Classification Result\").item.json.current_step_number }}, 'auto_response_sent', json_build_object('type', 'meeting_availability'));"),
      options: {}
    },
    position: [2640, 200]
  },
  output: [{}]
});

sticky(
  '## Reply Watcher + Auto-Responder\\n\\nWatches Gmail for new replies, matches sender to leads DB, classifies reply with AI (interested/not_interested/OOO/unsubscribe), updates lead status, and auto-responds to interested leads with calendar availability.\\n\\n**Setup:** Configure Gmail OAuth2, Supabase Postgres, OpenAI API, and Google Calendar OAuth2 credentials.',
  [gmailTrigger],
  { color: 2 }
);

export default workflow('reply-watcher', 'Slope-Side: Reply Watcher')
  .add(gmailTrigger)
  .to(matchLead)
  .to(checkLeadFound
    .onTrue(classifyReply
      .to(parseClassification)
      .to(logReplyEvent)
      .to(checkInterested
        .onTrue(getCalendarEvents
          .to(findSlots)
          .to(sendAutoResponse)
          .to(logAutoResponse))
        .onFalse()
      )
    )
    .onFalse()
  );

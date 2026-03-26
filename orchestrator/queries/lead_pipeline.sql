-- Lead status breakdown
SELECT status, COUNT(*) as count
FROM leads
GROUP BY status
ORDER BY count DESC;

-- Active leads in sequence with timing info
SELECT
  lss.status,
  COUNT(*) as count,
  MIN(lss.next_action_at) as earliest_action,
  MAX(lss.next_action_at) as latest_action
FROM lead_sequence_state lss
GROUP BY lss.status;

-- Leads enrolled but not yet sent any email
SELECT l.first_name, l.last_name, l.email, l.company, lss.next_action_at
FROM lead_sequence_state lss
JOIN leads l ON l.id = lss.lead_id
WHERE lss.status = 'active' AND lss.current_step_number = 1
AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.lead_id = l.id AND e.event_type = 'email_sent'
)
ORDER BY lss.next_action_at;

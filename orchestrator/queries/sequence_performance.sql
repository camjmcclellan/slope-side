-- Per-step conversion rates: which steps generate replies
SELECT
  ss.step_number,
  ss.delay_days,
  ss.subject_template,
  COUNT(CASE WHEN e.event_type = 'email_sent' THEN 1 END) as sent,
  COUNT(CASE WHEN e.event_type = 'email_replied' THEN 1 END) as replies,
  ROUND(
    COUNT(CASE WHEN e.event_type = 'email_replied' THEN 1 END)::numeric /
    NULLIF(COUNT(CASE WHEN e.event_type = 'email_sent' THEN 1 END), 0) * 100, 1
  ) as reply_rate_pct,
  COUNT(CASE WHEN e.event_type = 'reply_classified' AND e.metadata->>'classification' = 'interested' THEN 1 END) as interested,
  COUNT(CASE WHEN e.event_type = 'meeting_booked' THEN 1 END) as meetings
FROM sequence_steps ss
LEFT JOIN events e ON e.sequence_id = ss.sequence_id AND e.step_number = ss.step_number
WHERE ss.sequence_id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
GROUP BY ss.step_number, ss.delay_days, ss.subject_template
ORDER BY ss.step_number;

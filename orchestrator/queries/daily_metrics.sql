-- Funnel metrics for the last 7 days
SELECT
  event_type,
  COUNT(*) as count,
  COUNT(DISTINCT lead_id) as unique_leads
FROM events
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY event_type
ORDER BY
  CASE event_type
    WHEN 'email_sent' THEN 1
    WHEN 'email_replied' THEN 2
    WHEN 'reply_classified' THEN 3
    WHEN 'auto_response_sent' THEN 4
    WHEN 'meeting_booked' THEN 5
    WHEN 'bounced' THEN 6
  END;

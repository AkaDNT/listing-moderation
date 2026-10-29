WITH moment AS (SELECT clock_timestamp() AS at)
SELECT j.id AS job_id,j.listing_id,j.state,j.attempts,j.available_at,j.lease_until,
  j.last_error,l.status AS listing_status,
  (SELECT count(*)::int FROM moderation_history h WHERE h.listing_id=j.listing_id) AS phase_history_count,
  CASE
    WHEN j.state='running' AND (j.claim_token IS NULL OR j.lease_until IS NULL) THEN 'invalid_running_metadata'
    WHEN j.state='running' AND j.attempts>=5 AND j.lease_until<=moment.at THEN 'exhausted_due'
    WHEN j.state='running' AND j.lease_until<=moment.at THEN 'expired_lease_recoverable'
    WHEN j.state='running' THEN 'running_live'
    WHEN j.state='queued' AND j.attempts>=5 AND j.available_at<=moment.at THEN 'exhausted_due'
    WHEN j.state='queued' AND j.available_at>moment.at THEN 'queued_backoff'
    WHEN j.state='queued' THEN 'queued_due'
    WHEN j.state='failed' THEN 'failed_needs_inspection'
    WHEN j.state='completed' THEN 'completed'
    ELSE 'unexpected_state'
  END AS operational_state
FROM moderation_jobs j
JOIN listings l ON l.id=j.listing_id
CROSS JOIN moment
ORDER BY j.created_at,j.id;

-- Run in an interactive psql session. COMMIT only if step 3 returns exactly one row.
-- Supply psql variables listing_id, job_id, expected_attempts, expected_error.
BEGIN;
-- T11 STEP 1: lock listing before job, matching production lock order.
SELECT id,status FROM listings WHERE id=:'listing_id' FOR UPDATE;
-- T11 STEP 2: inspect the exact job and its current diagnostic.
SELECT id,listing_id,state,attempts,last_error FROM moderation_jobs
WHERE id=:'job_id' AND listing_id=:'listing_id' FOR UPDATE;
-- T11 STEP 3: guarded requeue; zero rows means ROLLBACK and inspect again.
UPDATE moderation_jobs j
SET state='queued',attempts=0,available_at=clock_timestamp(),claim_token=NULL,
    lease_until=NULL,completed_at=NULL,last_error=NULL
WHERE j.id=:'job_id' AND j.listing_id=:'listing_id' AND j.state='failed'
  AND j.attempts=:'expected_attempts'::int AND j.last_error IS NOT DISTINCT FROM :'expected_error'
  AND EXISTS (SELECT 1 FROM listings l WHERE l.id=j.listing_id AND l.status='pending')
  AND NOT EXISTS (SELECT 1 FROM moderation_history h WHERE h.listing_id=j.listing_id)
RETURNING j.id,j.listing_id,j.state,j.attempts;

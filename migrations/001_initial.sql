CREATE TABLE sellers (
  id text PRIMARY KEY,
  name text NOT NULL,
  trust_score integer NOT NULL CHECK (trust_score BETWEEN 0 AND 100),
  verified boolean NOT NULL,
  note text NOT NULL
);

CREATE TABLE categories (
  id text PRIMARY KEY,
  name text NOT NULL,
  median_price_vnd bigint NOT NULL CHECK (median_price_vnd > 0)
);

CREATE TABLE banned_keywords (
  term text PRIMARY KEY CHECK (length(btrim(term)) > 0)
);

CREATE TABLE listings (
  id text PRIMARY KEY,
  seller_id text NOT NULL REFERENCES sellers(id),
  category_id text NOT NULL REFERENCES categories(id),
  title text NOT NULL,
  description text NOT NULL,
  price_vnd bigint NOT NULL CHECK (price_vnd >= 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'auto_approved', 'auto_rejected', 'needs_human', 'published', 'rejected', 'expired')),
  decision jsonb,
  decided_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  normalized_fingerprint text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT listing_decision_shape CHECK (
    decision IS NULL OR (
      jsonb_typeof(decision) = 'object'
      AND decision ?& ARRAY['outcome', 'reasons']
      AND decision->>'outcome' IN ('approved', 'rejected', 'escalated')
      AND jsonb_typeof(decision->'outcome') = 'string'
      AND jsonb_typeof(decision->'reasons') = 'array'
    )
  ),
  CONSTRAINT listing_result_presence CHECK (
    (status = 'pending' AND decision IS NULL AND decided_at IS NULL)
    OR (status <> 'pending' AND decision IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE TABLE submission_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  listing_id text NOT NULL REFERENCES listings(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE moderation_jobs (
  id text PRIMARY KEY,
  listing_id text NOT NULL UNIQUE REFERENCES listings(id),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_until timestamptz,
  claim_token uuid,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE moderation_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id text NOT NULL REFERENCES listings(id),
  phase text NOT NULL CHECK (phase IN ('auto', 'human')),
  decision jsonb NOT NULL CHECK (
    jsonb_typeof(decision) = 'object'
    AND decision ?& ARRAY['outcome', 'reasons']
    AND decision->>'outcome' IN ('approved', 'rejected', 'escalated')
    AND jsonb_typeof(decision->'outcome') = 'string'
    AND jsonb_typeof(decision->'reasons') = 'array'
  ),
  moderator_id text,
  note text,
  decided_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (listing_id, phase)
);

CREATE INDEX listings_newest_idx ON listings (created_at DESC, id DESC);
CREATE INDEX listings_seller_newest_idx ON listings (seller_id, created_at DESC, id DESC);
CREATE INDEX listings_status_newest_idx ON listings (status, created_at DESC, id DESC);
CREATE INDEX listings_active_duplicate_idx
  ON listings (seller_id, normalized_fingerprint)
  WHERE status IN ('auto_approved', 'published');
CREATE INDEX submission_keys_listing_idx ON submission_keys (listing_id);
CREATE INDEX jobs_due_idx ON moderation_jobs (available_at, id) WHERE state = 'queued';
CREATE INDEX jobs_recovery_idx ON moderation_jobs (lease_until, id) WHERE state = 'running';

CREATE FUNCTION reject_moderation_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'moderation history is append-only';
  RETURN NULL;
END;
$$;

CREATE TRIGGER moderation_history_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON moderation_history
FOR EACH STATEMENT EXECUTE FUNCTION reject_moderation_history_mutation();

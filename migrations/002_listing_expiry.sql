CREATE INDEX listings_published_expiry_idx
  ON listings (expires_at,id) WHERE status='published';

CREATE TABLE IF NOT EXISTS rate_limiter_buckets (
  key           TEXT        NOT NULL PRIMARY KEY,
  tokens        REAL        NOT NULL,
  last_refill   TIMESTAMPTZ NOT NULL DEFAULT now(),
  drained_until TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z'
);

-- Recurring jobs: one row per scheduled kind, polled by the worker.
-- The next_run_at / last_enqueued_at pair with FOR UPDATE SKIP LOCKED gives exactly-once
-- enqueuing even with multiple workers.

create table scheduled_jobs (
  kind             text        primary key,
  payload          jsonb       not null default '{}',
  queue_key        text        not null default 'system',
  interval_ms      bigint      not null,
  next_run_at      timestamptz not null,
  last_enqueued_at timestamptz,
  enabled          boolean     not null default true
);

-- Global health of adapters checked by the canary, not per-athlete.
create table adapter_health (
  adapter    text        primary key,
  status     text        not null default 'unknown'
                           check (status in ('unknown', 'active', 'degraded')),
  reason     text,
  checked_at timestamptz not null default now()
);

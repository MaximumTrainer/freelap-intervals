-- Freelap → intervals.icu sync: initial schema.

create table users (
  id          uuid primary key default gen_random_uuid(),
  email       text        not null unique,
  created_at  timestamptz not null default now()
);

-- One row per connected external account. Secrets are stored only as sealed envelopes.
create table connections (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references users (id) on delete cascade,
  provider            text        not null check (provider in ('intervals_icu', 'myfreelap')),
  external_account_id text,
  scopes              text[]      not null default '{}',
  secret_envelope     text,
  expires_at          timestamptz,
  status              text        not null default 'active'
                        check (status in ('active', 'needs_reconnect', 'degraded')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, provider)
);

-- The CSRF state of an in-flight OAuth authorization, valid only briefly.
create table oauth_states (
  state        text        primary key,
  user_id      uuid        not null references users (id) on delete cascade,
  redirect_uri text        not null,
  created_at   timestamptz not null default now()
);

-- Canonical sessions, kept as the payload the rest of the system already speaks.
create table sprint_sessions (
  source_id     text        primary key,
  user_id       uuid        not null references users (id) on delete cascade,
  athlete_ref   text        not null,
  started_at    timestamptz not null,
  sport         text        not null,
  exercise_name text        not null,
  distance_m    numeric,
  payload       jsonb       not null,
  imported_at   timestamptz not null default now()
);

create index sprint_sessions_by_user on sprint_sessions (user_id, started_at desc);

-- The sync ledger: which session landed on which activity, and how that went.
create table syncs (
  source_id    text        primary key references sprint_sessions (source_id) on delete cascade,
  user_id      uuid        not null references users (id) on delete cascade,
  activity_id  text        not null,
  mode         text        not null check (mode in ('attach', 'create-new')),
  status       text        not null check (status in ('pending', 'synced', 'failed', 'drifted')),
  content_hash text        not null,
  failed_step  text,
  synced_at    timestamptz not null default now()
);

create index syncs_by_user on syncs (user_id, synced_at desc);

-- Every read-back check ever run, newest last.
create table verifications (
  id         bigserial   primary key,
  source_id  text        not null references syncs (source_id) on delete cascade,
  status     text        not null check (status in ('pass', 'partial', 'fail')),
  diffs      jsonb       not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);

create index verifications_by_source on verifications (source_id, id desc);

-- Column mappings the athlete corrected by hand, remembered per export layout.
create table column_mappings (
  user_id     uuid        not null references users (id) on delete cascade,
  fingerprint text        not null,
  mapping     jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, fingerprint)
);

-- Every call this integration makes to somebody else's system.
create table audit_log (
  id          bigserial   primary key,
  user_id     uuid        references users (id) on delete set null,
  action      text        not null,
  target      text,
  status_code integer,
  outcome     text        not null check (outcome in ('ok', 'error')),
  detail      jsonb       not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create index audit_log_by_user on audit_log (user_id, id desc);

-- Background work, claimed with SKIP LOCKED so many workers can share one queue.
create table jobs (
  id           bigserial   primary key,
  kind         text        not null,
  payload      jsonb       not null,
  status       text        not null default 'queued'
                 check (status in ('queued', 'running', 'done', 'failed')),
  attempts     integer     not null default 0,
  max_attempts integer     not null default 5,
  run_after    timestamptz not null default now(),
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index jobs_claimable on jobs (status, run_after) where status = 'queued';

-- Server-side sessions, so individual cookies can be revoked and expired.
create table sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index sessions_by_user on sessions (user_id);

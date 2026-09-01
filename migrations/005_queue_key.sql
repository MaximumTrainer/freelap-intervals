-- Per-athlete queue fairness (C4): each job belongs to a queue key, and claim()
-- round-robins across keys so one athlete's backlog cannot starve another.

alter table jobs add column queue_key text not null default 'system';

update jobs set queue_key = coalesce(payload->>'userId', 'system');

create index jobs_queue_key_claimable
    on jobs (queue_key, run_after, id) where status = 'queued';

create index jobs_queue_key_running
    on jobs (queue_key) where status = 'running';

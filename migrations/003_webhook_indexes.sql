-- Index the webhook lookup path so the join does not scan connections and syncs.
--
-- The webhook query (PgSyncDirectory.findByActivity):
--   select s.user_id, s.source_id
--     from syncs s
--     join connections c on c.user_id = s.user_id and c.provider = 'intervals_icu'
--    where c.external_account_id = $1 and s.activity_id = $2

-- (provider, external_account_id): provider leads because the join always
-- constrains provider = 'intervals_icu', so the leading column filters half
-- the table before external_account_id narrows to the specific athlete.
-- Not unique: two users may legitimately connect the same intervals.icu account.
create index connections_by_external on connections (provider, external_account_id);

-- activity_id: the webhook handler looks up which sync owns a given activity.
create index syncs_by_activity on syncs (activity_id);

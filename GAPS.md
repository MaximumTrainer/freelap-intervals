# Gaps between the design and the build

A review of [the design](freelap-intervals-icu-integration-design.md) against what is in this
repository, so the remaining work can be picked up in order. Every item below was checked against
the code, not from memory; section references are to the design document.

**Priorities.** P1 must be closed before any real athlete's data goes through this.
P2 is needed for the design's own exit criteria. P3 is quality and operability.

**Effort.** XS ≈ minutes · S ≈ half a day · M ≈ 1–3 days · L ≈ a week or more.

| Theme | P1 | P2 | P3 | Blocked |
| --- | --- | --- | --- | --- |
| [Security & privacy](#security--privacy) | 4 | 3 | — | — |
| [Correctness & robustness](#correctness--robustness) | — | 4 | 4 | — |
| [Unbuilt design requirements](#unbuilt-design-requirements) | — | 3 | 4 | — |
| [Operations](#operations) | — | 3 | 2 | — |
| [Test depth](#test-depth) | — | 1 | 3 | — |
| [Blocked on the real world](#blocked-on-the-real-world) | — | — | — | 7 |

---

## Security & privacy

- [ ] **S1 · No CSRF protection on state-changing requests** — P1 · S
  Every POST (`/sessions/:id/sync`, `/account/purge`, `/disconnect/:provider`,
  `/connect/myfreelap`) accepts a plain form with no token. The session cookie is `SameSite=Lax`,
  which stops cross-site POSTs in current browsers, but that is the only thing standing between a
  hostile page and an athlete's *delete everything* button.
  **Do:** issue a per-session token, render it as a hidden field in
  [views.ts](src/web/views.ts), and check it in `handle()` in [web-app.ts](src/web/web-app.ts) for
  every non-GET route outside `PUBLIC_PATHS`.

- [ ] **S2 · The webhook endpoint is unauthenticated** — P1 · S
  `POST /webhooks/intervals-icu` ([webhook-routes.ts](src/web/routes/webhook-routes.ts)) is public
  and verifies nothing. Anyone who guesses an athlete id and activity id can enqueue verification
  work indefinitely. It writes nothing, so the risk is queue amplification rather than data loss.
  **Do:** verify whatever intervals.icu signs its webhooks with (settled by **B4**), or failing
  that a shared secret in the callback URL, and rate-limit the route.

- [ ] **S3 · Session cookie is not hardened** — P1 · XS
  [session-cookie.ts](src/web/session-cookie.ts) sets `HttpOnly; SameSite=Lax` but no `Secure`, no
  expiry, and there is no way to revoke a signed cookie short of rotating the secret for everyone.
  **Do:** add `Secure` (behind a config flag for local HTTP), give the cookie a `Max-Age`, and put
  a session id — not the raw user id — in it so single sessions can be revoked.

- [ ] **S4 · OAuth states never expire and are never cleaned up** — P1 · S
  The design calls them "valid only briefly" (§4.1.3). `consume()` in
  [oauth-state-store.ts](src/auth/oauth-state-store.ts) deletes by value with no age check, so a
  state issued months ago still completes a connection, and abandoned rows accumulate forever.
  **Do:** reject states older than a few minutes in the `delete … returning` predicate, and sweep
  old rows from the same job that does the other retention work (**C8**).

- [ ] **S5 · No limit on upload size** — P2 · S
  `readRequestBody()` in [http.ts](src/web/http.ts) buffers the whole request in memory. A large
  upload is a cheap way to exhaust a web node.
  **Do:** cap the body (a few MB is generous for a CSV export), reject with 413 beyond it.

- [ ] **S6 · No rate limiting of our own outbound calls** — P2 · M
  §4.2 asks for "polite rate limits" toward MyFreelap; §6 asks for a queue per athlete for
  intervals.icu. Today there is exponential backoff *after* a 429
  ([http-intervals-icu-client.ts](src/icu/http-intervals-icu-client.ts)) but nothing that paces
  requests before one arrives, and the MyFreelap adapter has no pacing at all.
  **Do:** a small token-bucket limiter shared by both clients, plus **C4**.

- [ ] **S7 · Adapter degradation alerts nobody** — P2 · S
  §6 asks to "alert maintainers" when the Freelap adapter breaks. The canary marks the connection
  degraded and writes an audit row ([canary-job.ts](src/jobs/canary-job.ts)); nothing sends that
  anywhere a maintainer will see it.
  **Do:** an alert sink behind a port (email, Slack, PagerDuty), called on degradation and on
  repeated job failures.

## Correctness & robustness

- [ ] **C1 · Partial writes are not rolled back** — P2 · M
  §6 asks that a failure part-way through roll back "only our intervals/description block". The
  writer records which step failed ([activity-writer.ts](src/write/activity-writer.ts)) and the
  ledger keeps it, but whatever was already written stays. A sync that dies after intervals and
  before the description leaves the activity in a half-updated state until someone re-syncs.
  **Do:** capture the prior intervals and description before writing, and undo our own changes on
  failure; re-sync already repairs, so this is about not leaving a mess in the meantime.

- [ ] **C2 · The content hash is written but never read** — P3 · S
  `intendedContentHash()` ([sync-application.ts](src/app/sync-application.ts)) is stored on every
  ledger row and compared against nothing. An unchanged re-sync therefore does the full write again
  rather than short-circuiting — correct, but wasteful, and not what the ledger hash is for (§3.1).
  **Do:** skip the write when the hash matches and the last verification passed; keep a `--force`
  path for repairing drift.

- [ ] **C3 · A session that spans midnight becomes two sessions** — P2 · S
  Sessions are grouped by local calendar date in
  [csv-adapter.ts](src/ingest/csv/csv-adapter.ts), so an evening session running past midnight
  splits in two. §6 lists this as an edge case to handle.
  **Do:** group by a gap heuristic (reps within, say, three hours of the previous one) rather than
  by date alone; add a fixture that crosses midnight.

- [ ] **C4 · The queue is global, not per athlete** — P3 · M
  §6 asks for a queue per athlete so one athlete's backlog or rate-limit penalty cannot delay
  everyone else. [pg-job-queue.ts](src/jobs/pg-job-queue.ts) claims strictly by `run_after, id`.
  **Do:** add an athlete key to `jobs` and claim round-robin across keys.

- [ ] **C5 · No automatic clock-offset suggestion** — P2 · M
  §5.3 asks for a default offset from first-rep speed-peak detection when streams exist. The review
  screen has the slider and the stream preview, but it always starts at zero
  ([views.ts](src/web/views.ts)).
  **Do:** cross-correlate the rep starts against speed peaks in `previewFor()` and pre-set the
  slider; keep it a suggestion the athlete can override.

- [ ] **C6 · Intervals are identified by name only, not by a tag** — P3 · S
  §5.3 specifies "deterministic names **and** a `freelap` tag" for safe re-sync. Only the `FL #`
  name prefix is used ([interval-naming.ts](src/domain/interval-naming.ts)). An athlete who renames
  one of our intervals orphans it: the next sync will not replace it and will add a duplicate.
  **Do:** write the tag if the API supports one, and treat name-or-tag as ownership.

- [ ] **C7 · Mode A against an activity with no streams collapses to index 0** — P2 · S
  `nearestIndex()` over an empty `time` array returns 0 for every rep, so every interval would be
  written at the start of the activity. Manually-created activities have no streams.
  **Do:** detect an empty stream in the writer, refuse Mode A with a clear message, and offer
  Mode B instead.

- [ ] **C8 · Nothing is ever cleaned up** — P3 · S
  Finished `jobs` rows, old `audit_log` rows and stale `oauth_states` accumulate without bound.
  **Do:** one retention job with configurable windows; note that the audit trail deliberately
  outlives accounts ([PRIVACY.md](PRIVACY.md)), so it needs a longer window, not deletion.

## Unbuilt design requirements

- [ ] **F1 · The MyFreelap web adapter is unreachable from the UI** — P2 · M
  §5.2 wants a list of recent Freelap sessions to pick from.
  [`FreelapSources.webSourceFor`](src/ingest/freelap-sources.ts) is used only by the canary: there
  is no route that lists or imports sessions from the web source, so with the flag on an athlete
  still has nothing to click.
  **Do:** a "fetch my sessions" route and screen backed by `listSessions`/`getSession`, feeding
  `SyncApplication.importSessions`.

- [ ] **F2 · The application does not consume the `FreelapSource` port** — P2 · M
  §2's decision is two implementations behind one interface. Both exist and both are tested, but
  the production CSV path calls `readSessions` directly from
  [sync-application.ts](src/app/sync-application.ts), and
  [`CsvFreelapSource`](src/ingest/csv/csv-freelap-source.ts) is referenced only by tests. The
  abstraction is not actually carrying the design's weight.
  **Do:** route both paths through the port (it pairs naturally with **F1**), or delete
  `CsvFreelapSource` and admit the port is web-only.

- [ ] **F3 · Nothing schedules the canary, and it watches the wrong account** — P2 · S
  §9 asks for a nightly login-and-list against *a dedicated MyFreelap test account*. The handler
  exists ([canary-job.ts](src/jobs/canary-job.ts)) but nothing ever enqueues `freelap-canary`, and
  as written it would sign in as each athlete — which sits badly with §4.2's "no background
  polling; fetch on user action only".
  **Do:** a scheduler (cron or a due-jobs table) enqueuing one canary against a configured test
  account; keep per-athlete checks strictly user-triggered.

- [ ] **F4 · No live health check on the connect screen** — P3 · S
  §5.1 asks for `GET /api/v1/athlete/{id}` and a Freelap session-list fetch, shown green/red per
  source. The dashboard shows stored connection status only, which can be stale.
  **Do:** probe both on the connections screen, with the result cached briefly.

- [ ] **F5 · Mode A speed stream — open question 11.2** — P3 · M
  Whether to write Freelap speeds as a custom activity stream so they chart alongside watch data
  was left open, and is not built. Decide before beta; intervals plus fields may well be enough.

- [ ] **F6 · The exact OAuth scopes are not shown before connecting** — P3 · XS
  §7 asks to show them. The dashboard paraphrases ("read your activities and write intervals").
  **Do:** render the literal `ACTIVITY:READ ACTIVITY:WRITE` alongside the plain-English line.

- [ ] **F7 · No sign-out link** — P3 · XS
  `POST /sign-out` exists in [web-app.ts](src/web/web-app.ts) and nothing links to it.

## Operations

- [ ] **O1 · No CI** — P2 · S
  A Phase 1 deliverable. `npm run check` is green locally and needs no services, so this is one
  workflow file away.

- [ ] **O2 · No deployment artifacts** — P2 · M
  No Dockerfile, compose file or manifest, and §11.4 (hosting, mobile-first or not) is still open.
  Web and worker are separate processes sharing one database, which keeps the choice open.

- [ ] **O3 · No structured logging, metrics or error reporting** — P2 · M
  The worker prints to the console; the web app swallows errors into a 500 page. There is no way to
  see sync success rate, queue depth or latency — and §8's Phase 5 exit criterion is "<2% failed
  syncs over beta", which cannot currently be measured.
  **Do:** a logger port with request/job correlation ids, counters for sync outcomes, and an error
  reporter.

- [ ] **O4 · Missing index for the webhook lookup** — P3 · XS
  [`PgSyncDirectory.findByActivity`](src/ledger/sync-directory.ts) joins on
  `connections.external_account_id`, which is unindexed.

- [ ] **O5 · Key rotation has no operator entry point** — P3 · S
  `ConnectionStore.resealAll()` is implemented and tested but reachable only from code.
  **Do:** an `npm run reseal` command, and document the rotation runbook.

## Test depth

- [ ] **T1 · The locale and separator matrix is sampled, not covered** — P3 · S
  §9 asks for a matrix. Four fixtures exist: semicolon/comma-decimal, comma/dot-decimal,
  no-speed-columns, multi-session. Tab separation, `mm:ss` times, thousands separators and
  month-first dates are exercised in unit tests but not as end-to-end fixtures.

- [ ] **T2 · Contract tests are hand-written, not recorded** — P2 · S (after **B4**)
  §9 asks for VCR-style recorded intervals.icu responses. Ours assert the shapes this code
  *expects*, which is useful but cannot catch a shape that was never right.

- [ ] **T3 · No test for a malformed-but-successful MyFreelap payload** — P3 · S
  [myfreelap-payloads.ts](src/ingest/myfreelap/myfreelap-payloads.ts) validates every field and
  degrades precisely, but only the 404 and HTML paths are covered. Schema drift — the thing the
  validation exists for — is untested.

- [ ] **T4 · No test with a long activity** — P3 · S
  Streams are thinned for the preview and searched linearly for interval indices. A three-hour
  activity at 1 Hz is ~10k samples; nothing checks that behaviour or timing.

## Blocked on the real world

None of these can be closed from inside this repository.

- [ ] **B1 · Capture real MyFreelap traffic** (§2, §11.1) — the endpoints and payloads in
  [myfreelap-payloads.ts](src/ingest/myfreelap/myfreelap-payloads.ts) are an assumption. Until this
  is done the web adapter should stay behind its flag.
- [ ] **B2 · Collect ≥10 real CSV exports with varied app settings** (§8 Phase 0) — the four
  fixtures here are written by hand, so the normaliser has never met a real export.
- [ ] **B3 · Register the intervals.icu OAuth app** (§4.1) — needs name, description, website,
  logo, privacy policy URL ([PRIVACY.md](PRIVACY.md) is ready to publish) and redirect URIs.
- [ ] **B4 · Confirm every endpoint against the live API** (§12) — particularly the custom-field
  endpoint (`/api/v1/athlete/{id}/custom-item`), the streams response shape, the OAuth token URL,
  the webhook payload and signature, and the API-key scheme: §4.1.6 names
  `Authorization: ApiKey API_KEY:<key>` whereas [the client](src/icu/http-intervals-icu-client.ts)
  sends HTTP Basic with the `API_KEY` user. One of the two is wrong.
- [ ] **B5 · Validate a synthetic FIT with the official Garmin FIT SDK** (§9) — ours round-trips
  through [our own decoder](src/write/fit/fit-decoder.ts), which shares any misreading of the spec
  with the encoder.
- [ ] **B6 · End-to-end against a sandbox intervals.icu athlete, then a 5–10 athlete beta**
  (§8, §9) — everything here runs against a fake, however faithful.
- [ ] **B7 · Legal review of credentialed access to MyFreelap, and an approach to Freelap about a
  data-export agreement** (§10, §11.5).

## Decisions already taken

These differ from the design on purpose and are not gaps; the reasoning is in
[README](README.md#decisions-that-differ-from-the-design-doc): rep wall clocks read as rep starts;
interval timing verified to ±1.0 s in both modes; attaching to another session's activity refused
up front; a Postgres queue rather than Redis/BullMQ; email-only sign-in with a signed cookie
standing in for real authentication.

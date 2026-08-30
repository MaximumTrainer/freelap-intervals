# Freelap → intervals.icu Sprint Sync

Takes a timed sprint session from a Freelap system and writes it into intervals.icu — as structured
intervals, summary custom fields and a human-readable rep table — then reads the activity back and
reports every way it differs from what was intended.

All six phases of [the design](freelap-intervals-icu-integration-design.md) are built: foundations,
ingestion, match & write, verify & re-sync, and hardening. 246 tests, no Docker needed to run them.

## Quick start

```bash
npm install
npm run check                     # typecheck + 246 tests (Postgres runs in-process via PGlite)

cp .env.example .env              # then fill it in; see Configuration below
npm run migrate                   # apply the SQL migrations
npm run web                       # the app, on http://localhost:3000
npm run worker                    # the background worker, in another terminal
```

Sign in, connect intervals.icu, upload a MyFreelap CSV export, review where it should go, and sync.

There is also a single-athlete CLI that needs no database and no OAuth app — a personal API key is
enough:

```bash
export INTERVALS_ICU_ATHLETE_ID=i12345 INTERVALS_ICU_API_KEY=your-key
npm run sync -- import ~/Downloads/freelap-export.csv
npm run sync -- plan csv-7000a729c534
npm run sync -- push csv-7000a729c534      # or --new / --attach a12345 / --offset -12
npm run sync -- verify csv-7000a729c534
```

## What a sync does

```text
CSV export ────┐
               ├─▶ normalise ─▶ SprintSession ─▶ match ─▶ write ─▶ verify ─▶ ledger
MyFreelap web ─┘                                            │
        (optional, flagged off)      Mode A: attach ────────┤ intervals + fields + description
                                     Mode B: create ────────┘ synthetic FIT upload, then the same
```

What lands on the activity:

- **Intervals** named `FL #4 · 30m · 3.35s` — deterministic, so a re-sync replaces only the
  intervals this app owns and leaves the athlete's warmups and cool-downs alone.
- **Custom fields** `fl_session_id`, `fl_rep_count`, `fl_best_s`, `fl_avg_s`, `fl_distance_m`.
- **A description block** fenced by `<!-- freelap:start -->` … `<!-- freelap:end -->` holding a rep
  table with intermediate splits and max speed. Only that block is replaced on re-sync.
- **`external_id`** `freelap:<sourceId>`, claimed only if the activity has none. An activity that
  already belongs to a different Freelap session is refused before anything is written.

## How it is put together

| Area | Where | What it does |
| --- | --- | --- |
| Ingest | [src/ingest/csv/](src/ingest/csv/) | Sniffs separator and decimal mark, maps headers (EN/FR), reads reps, splits, speeds; remembers corrections per export layout |
| MyFreelap web | [src/ingest/myfreelap/](src/ingest/myfreelap/) | Optional, flag-gated adapter for the private web backend, with a degradation path back to CSV |
| Match | [src/match/matcher.ts](src/match/matcher.ts) | Scores candidate activities ±1 day and explains each score |
| Write | [src/write/](src/write/) | Lays reps on a [timeline](src/write/session-timeline.ts), then uploads a [FIT file](src/write/fit/) or attaches to a watch recording |
| Verify | [src/verify/verifier.ts](src/verify/verifier.ts) | Reads back activity, intervals, fields and description; reports diffs |
| Storage | [migrations/](migrations/), [src/db/](src/db/) | Real Postgres schema and migrations; repositories behind ports |
| Secrets | [src/security/](src/security/) | Envelope encryption behind a KMS port; credentials never stored or logged in the clear |
| Auth | [src/auth/](src/auth/) | intervals.icu OAuth: authorize, callback, proactive refresh, reconnect |
| Jobs | [src/jobs/](src/jobs/) | Postgres queue (`skip locked`), worker with exponential backoff, nightly MyFreelap canary |
| Web | [src/web/](src/web/) | Server-rendered UI and JSON endpoints: connect, import, review with offset slider, sync, verify, audit, webhooks |
| CLI | [src/cli/](src/cli/) | The API-key path, with no database |

The canonical model is [SprintSession](src/domain/sprint-session.ts), exactly as in the design doc.
Both ingestion adapters produce the same one for the same session — that equality is
[a test](test/unit/ingest/myfreelap-web-source.test.ts).

## Configuration

See [.env.example](.env.example). The essentials:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `FREELAP_MASTER_KEYS` | `<key-id>:<base64 32-byte key>`, comma-separated, newest last. Old keys stay so secrets sealed before a rotation still open |
| `FREELAP_CURRENT_KEY_ID` | Which master key seals new secrets |
| `SESSION_COOKIE_SECRET` | Signs the session cookie |
| `INTERVALS_ICU_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Your registered intervals.icu OAuth app |
| `FREELAP_WEB_ADAPTER` | `on` to expose the unofficial MyFreelap adapter. Off by default |

Rotating keys: add a new key, point `FREELAP_CURRENT_KEY_ID` at it, then call
`ConnectionStore.resealAll()` — new secrets seal under the new key immediately, and existing ones
are re-sealed without anyone re-entering a password.

## Tests

```bash
npm test          # everything
npx vitest        # watch
```

| Layer | Location | What it proves |
| --- | --- | --- |
| Acceptance | [test/acceptance/](test/acceptance/) | Use cases against an in-memory intervals.icu: create-new, attach, offset nudge, idempotent re-sync, drift, ownership refusal, and the same flow on Postgres |
| Unit | [test/unit/](test/unit/) | Dialect sniffing, column mapping, timezone maths, timeline, FIT codec, matcher, description block, envelope encryption, OAuth, queue, canary, CLI |
| Contract | [test/contract/](test/contract/) | The HTTP client's wire shapes, auth, backoff and token refresh; and one storage contract run against **both** the in-memory and Postgres repositories |
| End-to-end | [test/e2e/](test/e2e/) | The CLI and the whole web app over real HTTP against a [server speaking intervals.icu's shapes](test/support/fake-intervals-icu-server.ts), with real Postgres and a real job queue |

Three things keep the doubles honest: the fake **decodes every uploaded FIT file** rather than
trusting it; the e2e suites run over real sockets; and the Postgres tests apply **the project's own
migrations** to a real Postgres compiled to WebAssembly, so the schema under test is the schema
that ships. An opt-in run against a real server needs only `DATABASE_URL` and `npm run migrate`.

## Decisions that differ from the design doc

1. **Rep wall clocks are rep *starts*.** The doc models `wall_clock` as the finish beacon and
   subtracts the rep duration. A MyFreelap CSV exports a displayed time of day per run, which we
   read as the moment the rep began; the subtraction would misplace every rep by its own duration.
   If real exports turn out to timestamp the finish, the change is one line in
   [csv-adapter.ts](src/ingest/csv/csv-adapter.ts).
2. **Interval timing verifies to ±1.0 s in both modes**, not ±0.05 s in Mode B. intervals.icu
   indexes streams at whole seconds, so an interval boundary can never sit closer than half a
   sample to the Freelap time. The exact times are preserved — and verified to the millisecond — in
   the custom fields and the hashed description block.
3. **Attaching to an activity owned by a different Freelap session is refused** before anything is
   written, rather than being detected afterwards. The ledger records the failure and the step.
4. **The queue is Postgres, not Redis/BullMQ.** `for update skip locked` gives many workers a
   shared queue with one less service to run. [`JobQueue`](src/jobs/job-queue.ts) is a port, so
   BullMQ can replace it without touching the handlers.
5. **Sign-in is by email alone.** Real authentication (magic link, password, SSO) is deliberately
   out of scope; [the cookie](src/web/session-cookie.ts) is signed, and swapping in a real identity
   provider means changing one route.

## What still needs the real world

- **Phase 0 discovery.** The MyFreelap endpoints and payload shapes in
  [myfreelap-payloads.ts](src/ingest/myfreelap/myfreelap-payloads.ts) are an assumption, isolated so
  a traffic capture is a one-file change. Every unexpected answer becomes an
  `AdapterDegradedError`, the connection is marked degraded by the nightly canary, and the athlete
  is steered back to CSV. The adapter stays off until `FREELAP_WEB_ADAPTER=on`.
- **The intervals.icu OAuth app** must be registered with intervals.icu (name, description,
  website, logo, privacy policy, redirect URIs). [PRIVACY.md](PRIVACY.md) is the policy to publish.
- **Endpoint shapes to confirm against the live API** before first real use, as the design's §12
  also warns — particularly custom fields (`/api/v1/athlete/{id}/custom-item`), the streams
  response, and the OAuth token URL. They are isolated in
  [http-intervals-icu-client.ts](src/icu/http-intervals-icu-client.ts) and
  [oauth-client.ts](src/auth/oauth-client.ts); the contract tests pin the shapes this code expects,
  so a mismatch is a one-file fix.
- **A cloud KMS.** [`KeyManagementService`](src/security/key-management.ts) is the port;
  [`LocalKeyManagementService`](src/security/local-kms.ts) is the self-hosted implementation. An
  AWS/GCP KMS adapter implements two methods.

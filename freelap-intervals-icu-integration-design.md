# Freelap → intervals.icu Sprint Sync
## Technical Design & Plan Outline

**Status:** Draft v0.1 · **Date:** 29 Aug 2026

---

## 1. Goal & Scope

**Goal:** Take a timed sprint session recorded by a Freelap system (stored in the user's MyFreelap account) and populate it into the matching intervals.icu activity — as structured intervals, summary fields and a human-readable description — then verify the write landed correctly.

**In scope (v1)**
- Single-athlete MyFreelap accounts (self-timed sessions).
- Sprint/track sessions: reps with total time, intermediate splits, distance, speed.
- Attach to an existing intervals.icu activity (e.g. watch-recorded run) **or** create a new activity if none exists.
- Read-back verification with a diff report.

**Out of scope (v1)**
- Team/multi-athlete sessions (coach → many athletes).
- Real-time/live timing.
- Writing back to Freelap.

---

## 2. Constraints & Key Facts

| System | Access model | Implication |
|---|---|---|
| **MyFreelap** | No public API. Data lives in the app + a web account (myfreelap.com), with PDF/CSV export that mirrors whatever is displayed on screen. CSV separator is user-configurable in app settings. | Need either (a) credentialed access to the private web backend, or (b) CSV import. Any private-endpoint use is unofficial and may break or breach ToS. |
| **intervals.icu** | Public REST API. OAuth 2.0 with granular scopes for third-party apps; personal API key for own-data use. Supports activity upload (FIT/TCX/GPX), intervals, custom fields, webhooks, and external-ID mapping. | Clean, supported path. OAuth app must be registered by emailing intervals.icu (name, description, website, logo, privacy policy, redirect URIs). |

**Design decision:** Treat Freelap ingestion as a pluggable *adapter* with two implementations behind one interface, so the product survives if the private web endpoints change:

1. `MyFreelapWebAdapter` – logs in with user credentials, fetches session list + detail JSON.
2. `CsvAdapter` – user uploads the CSV exported from MyFreelap (always-works fallback, also used for testing).

---

## 3. Architecture

```
┌────────────┐     ┌────────────────────────────┐     ┌──────────────────┐
│  Browser / │────▶│  Web App (API + UI)        │────▶│  intervals.icu   │
│  Mobile    │     │  - OAuth callback          │     │  REST API        │
└────────────┘     │  - Session picker / match  │     └──────────────────┘
                   │  - Sync + verify orchestr. │
                   └─────────┬──────────────────┘
                             │ jobs
                   ┌─────────▼──────────────────┐     ┌──────────────────┐
                   │  Worker (queue consumer)   │────▶│  MyFreelap web   │
                   │  - Freelap adapter         │     │  (private, via   │
                   │  - Normaliser              │     │   user creds)    │
                   │  - Mapper → intervals.icu  │     └──────────────────┘
                   │  - Verifier                │
                   └─────────┬──────────────────┘
                             │
                   ┌─────────▼──────────────────┐
                   │  Postgres + KMS-backed     │
                   │  secret store              │
                   └────────────────────────────┘
```

**Suggested stack** (swap freely): TypeScript/Node or Python; Postgres; Redis/BullMQ or Celery for jobs; Playwright only if the web adapter needs a real browser; cloud KMS for envelope encryption.

### 3.1 Components

| Component | Responsibility |
|---|---|
| **Auth service** | intervals.icu OAuth (authorize → code → token → refresh); MyFreelap credential capture & encrypted storage. |
| **Freelap adapter** | `listSessions(from,to)`, `getSession(id)` → raw payload. Web impl handles login, cookies/CSRF, rate limiting. CSV impl parses uploads (separator auto-detect). |
| **Normaliser** | Raw → canonical `SprintSession` model (below). Handles units, separators, locale decimals, timezone. |
| **Matcher** | Finds candidate intervals.icu activities for a session. |
| **Mapper/Writer** | Builds intervals, description, custom fields, or a synthetic FIT; writes via API. |
| **Verifier** | Reads back and diffs against intent; produces pass/fail report. |
| **Sync ledger** | Table of `(freelap_session_id ↔ icu_activity_id, hash, status)` for idempotency and re-sync. |

### 3.2 Canonical data model

```ts
SprintSession {
  source_id: string            // Freelap session/workout id or CSV hash
  athlete_ref: string
  started_at: ISO8601 (tz-aware)
  sport: "run" | "cycling" | ...
  exercise_name: string        // e.g. "Flying 30m", "60m from blocks"
  distance_m: number | null
  reps: Rep[]
  summary: { best_s, worst_s, avg_s, count }
}
Rep {
  index: number
  wall_clock: ISO8601 | null   // when Freelap saw the finish beacon
  total_s: number
  splits: { at_m: number, elapsed_s: number }[]
  distance_m: number | null
  avg_speed_mps: number | null
  max_speed_mps: number | null
}
```

---

## 4. Authentication & Credential Handling

### 4.1 intervals.icu (OAuth 2.0)
1. Register the app with intervals.icu (redirect URIs; `http://localhost/` is allowed for dev).
2. Authorize URL: `https://intervals.icu/oauth/authorize` with `client_id`, `redirect_uri`, `response_type=code`, `scope`, `state` (CSRF).
3. Token exchange at the intervals.icu OAuth token endpoint (`grant_type=authorization_code`, then `refresh_token`). Store `access_token`, `refresh_token`, `expires_at`, `athlete_id`, granted `scope`.
4. **Scopes:** `ACTIVITY:READ ACTIVITY:WRITE` minimum. Add `CALENDAR:READ` only if matching against planned workouts is added later. Request the minimum.
5. Refresh proactively (e.g. 5 min before expiry); on 401, refresh once then surface "reconnect" to the user.
6. Dev/test path: personal API key via `Authorization: ApiKey API_KEY:<key>` against the same endpoints.

### 4.2 MyFreelap (user credentials)
- Collected once in-app over TLS with explicit consent text ("we store your MyFreelap login to fetch your sessions; you can delete it any time").
- Encrypted at rest with envelope encryption (per-user DEK, KMS-wrapped). Never logged, never returned to the client after save.
- Web adapter logs in, keeps a short-lived session cookie in memory/redis (encrypted), re-authenticates on expiry. Respect polite rate limits; no background polling in v1 — fetch on user action only.
- "Disconnect" wipes credentials and cached cookies immediately.
- Ship the CSV adapter as first-class so users who refuse to share credentials can still use the product.

---

## 5. Core Flows

### 5.1 Connect
1. User signs in → connects intervals.icu (OAuth) → adds MyFreelap credentials **or** chooses CSV mode.
2. Health checks: `GET /api/v1/athlete/{id}` (icu) and a Freelap session-list fetch. Show green/red status per source.

### 5.2 Select & Match
1. List recent Freelap sessions (date, exercise, rep count, best time).
2. For a chosen session, query `GET /api/v1/athlete/{id}/activities?oldest=&newest=` for a ±1 day window around `started_at`.
3. Score candidates: same date (+++), sport run/track (++), time overlap with session start (++), name contains "sprint|track|speed" (+), no existing Freelap link (+). Present the top candidates; user confirms or picks **"Create new activity"**.
4. Persist the choice in the sync ledger.

### 5.3 Write — Mode A: attach to existing activity
Applies when the athlete also recorded the session on a watch and wants Freelap precision layered onto it.

- **Interval alignment:** compute each rep's `start_s = rep.wall_clock − activity.start_date_local − rep.total_s` (finish beacon minus duration). Because Freelap and watch clocks drift, provide a **global offset slider** in the review UI with a stream preview; default offset from first-rep speed-peak detection if streams are available.
- **Intervals:** write via the activity intervals endpoint (`PUT /api/v1/activity/{id}/intervals`), one interval per rep, named deterministically (`FL #3 · 60m · 7.21s`). Deterministic names + a `freelap` tag allow safe re-sync (delete-then-recreate only intervals we own).
- **Custom fields** (create once per athlete via the custom-field API): `fl_best_s`, `fl_avg_s`, `fl_rep_count`, `fl_distance_m`, `fl_session_id`.
- **Description:** append a fenced block between markers `<!-- freelap:start -->` … `<!-- freelap:end -->` containing a rep/split table. Replace only that block on re-sync.
- **external_id:** set to `freelap:<source_id>` if the activity has none; otherwise store the link only in our ledger.

### 5.4 Write — Mode B: create new activity
Applies when no watch recording exists.

- Generate a **synthetic FIT file**: one lap per rep (with `total_elapsed_time`, `total_distance`, `avg_speed`, `max_speed`), a sparse speed/distance record stream built from the splits, session summary, `sport=running`, `sub_sport=track`. Rest between reps modelled as zero-speed gaps using wall-clock timestamps.
- Upload via `POST /api/v1/athlete/{id}/activities` (multipart) with `name`, `description`, and `external_id=freelap:<source_id>`.
- Then apply the same custom fields + description block as Mode A. Intervals should be auto-derived from laps; if not, write them explicitly as in Mode A.

### 5.5 Verify
Run immediately after write, and expose a "Re-verify" button.

| Check | Method | Pass criterion |
|---|---|---|
| Activity exists & linked | `GET /api/v1/activity/{id}` | 200; `external_id` or ledger link present |
| Interval count | `GET …/intervals` filtered by `FL #` prefix | equals `reps.length` |
| Interval timing | per-interval `end−start` vs `rep.total_s` | within ±0.05 s (Mode B) / ±1.0 s (Mode A, sample-rate bound) |
| Summary fields | read custom fields | exact match to canonical summary |
| Description block | regex extract between markers, hash | hash equals hash of what we sent |
| Idempotency | re-run write | zero net changes on second pass |

Output a verification record `{status: pass|partial|fail, diffs[]}` stored on the ledger row and shown in UI. Optional: subscribe to intervals.icu **webhooks** for activity updates so a later user edit on intervals.icu flips the row to "drifted".

---

## 6. Error Handling & Edge Cases

- **Freelap login fails / captcha / layout change:** mark adapter degraded, prompt CSV upload, alert maintainers.
- **CSV variations:** separator (`,` `;` `\t`), locale decimals (`7,21`), display-customised columns (export only includes what was on screen) → column-mapping UI with remembered mappings.
- **Multiple activities same day:** always confirm with user; never auto-write if score tie.
- **Session spans midnight / timezone mismatch:** store Freelap `started_at` tz-aware; use activity `start_date_local` + athlete timezone.
- **Partial write failure:** writes are ordered (activity → intervals → fields → description); on failure roll back only our intervals/description block, keep ledger status `failed` with step index for resume.
- **Rate limits (429):** exponential backoff with jitter; queue per athlete.
- **Token revoked on intervals.icu:** surface reconnect; do not retry blindly.

---

## 7. Security & Privacy

- Credentials and tokens: envelope-encrypted, KMS-managed keys, rotation supported.
- Least-privilege scopes; show the exact scopes on the connect screen.
- Data minimisation: store canonical session data only as long as needed for verify/re-sync; user-triggered purge.
- Audit log of every external write (who/what/when/response code).
- Privacy policy URL required for intervals.icu app registration — draft alongside the MVP.
- Clearly disclose that MyFreelap access is unofficial and may stop working.

---

## 8. Delivery Plan

| Phase | Deliverables | Exit criteria |
|---|---|---|
| **0 – Discovery (1 wk)** | Capture MyFreelap web traffic; document login + session/detail endpoints; collect ≥10 real CSV exports with varied settings; read intervals.icu API docs & cookbook; register OAuth app. | Endpoint notes + sample fixtures committed; OAuth client issued. |
| **1 – Foundations (1–2 wk)** | Repo, CI, Postgres schema (users, connections, ledger, verifications), secret store, intervals.icu OAuth flow, API-key dev mode. | User can connect intervals.icu and see athlete profile. |
| **2 – Ingestion (1–2 wk)** | `CsvAdapter` + normaliser with golden-file tests; `MyFreelapWebAdapter` behind feature flag. | Both adapters produce identical `SprintSession` for the same session. |
| **3 – Match & Write (2 wk)** | Matcher + review UI; Mode B (synthetic FIT upload); Mode A (intervals/fields/description); offset slider. | End-to-end sync on a test athlete in both modes. |
| **4 – Verify & Resync (1 wk)** | Verifier, diff report, idempotent re-sync, optional webhook drift detection. | Second sync = zero diffs; deliberate edit is detected. |
| **5 – Hardening & Beta (1–2 wk)** | Error handling, backoff, audit log, privacy policy, onboarding copy, beta with 5–10 athletes. | <2% failed syncs over beta; no credential leak findings in review. |

**Rough total:** 7–10 weeks for one engineer; ~5 with two.

---

## 9. Testing Strategy

- **Unit:** normaliser (locale/separator matrix), FIT builder (validate with FIT SDK decoder), matcher scoring, description block replace.
- **Contract:** recorded intervals.icu responses (VCR-style) for activities, intervals, custom fields, upload.
- **Adapter canaries:** nightly login + list against a dedicated MyFreelap test account; alert on schema drift.
- **E2E:** sandbox intervals.icu athlete; sync → verify → mutate → re-verify.

---

## 10. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MyFreelap private endpoints change or block automation | High | High | CSV adapter as first-class path; canaries; adapter isolated behind interface. |
| ToS / legal exposure from credentialed scraping | Medium | High | Legal review; user-action-only fetching; consider approaching Freelap for a data-export agreement. |
| Interval misalignment in Mode A (clock drift) | Medium | Medium | Offset slider + preview; store offset per session; default to Mode B when no streams. |
| intervals.icu API field/endpoint changes | Low | Medium | Contract tests; pin to documented endpoints; follow forum announcements. |
| Credential breach | Low | Critical | KMS envelope encryption, no plaintext logging, short-lived sessions, purge on disconnect. |

---

## 11. Open Questions

1. Does MyFreelap's web account expose JSON endpoints, or only server-rendered pages / downloadable CSV? (Drives adapter complexity — decided in Phase 0.)
2. Should Mode A also write a **speed stream** (custom activity stream) so Freelap speeds chart alongside watch data, or are intervals + fields sufficient for v1?
3. Team sessions: defer entirely, or store them and expose only the current athlete's rows?
4. Preferred hosting/runtime and whether a mobile-first UI is required at launch.
5. Is Freelap open to a formal partnership/API? Worth one email before building the scraper.

---

## 12. Reference Endpoints (verify against current intervals.icu API docs before build)

- Authorize: `https://intervals.icu/oauth/authorize`
- Athlete: `GET /api/v1/athlete/{id}`
- Activities list: `GET /api/v1/athlete/{id}/activities?oldest=YYYY-MM-DD&newest=YYYY-MM-DD`
- Activity: `GET|PUT /api/v1/activity/{id}`
- Intervals: `GET|PUT /api/v1/activity/{id}/intervals`
- Upload: `POST /api/v1/athlete/{id}/activities` (multipart FIT/TCX/GPX)
- Docs: `https://intervals.icu/api-docs.html`; forum threads "API access to Intervals.icu", "OAuth support", "API Integration Cookbook".

# User guide

## What this app does

You record sprint sessions with a Freelap timing system. This app takes those sessions and writes
them into your intervals.icu account as structured data: intervals aligned to your watch recording,
summary fields, and a rep table with splits and speeds. It then reads the activity back and confirms
everything landed correctly.

Your existing activity data is never overwritten. The app writes into a fenced area it owns and
leaves your warmups, cool-downs, and notes untouched.

## Signing in

Open the app in your browser and enter your email address. There is no password — the app identifies
you by email alone. A session cookie keeps you signed in for 30 days.

A **Sign out** button appears in the top-right of every page once you are signed in.

## Connecting intervals.icu

From the dashboard, click **Connect intervals.icu**. You will be redirected to intervals.icu to
approve two permissions:

- **ACTIVITY:READ** — to find the activity your session belongs to
- **ACTIVITY:WRITE** — to add intervals, summary fields, and a description block

After you approve, the app stores your tokens securely (encrypted at rest) and redirects you back to
the dashboard. You can disconnect at any time.

## Importing a sprint session

### Option A: CSV upload

1. Export your session from MyFreelap as a CSV file.
2. On the dashboard, click **Choose file** under the import card and select the CSV.
3. The app reads the file, detects the format (English or French headers, comma or semicolon
   separator), and creates a session for each exercise found.

If the app encounters columns it does not recognise, it shows a **column mapping** screen where you
assign each unknown header to a known field or mark it as "ignore." The mapping is remembered for
future exports with the same layout.

### Option B: MyFreelap web connection (optional)

If your operator has enabled the MyFreelap web adapter (`FREELAP_WEB_ADAPTER=on`), you can store
your MyFreelap credentials on the dashboard. The app will then fetch sessions directly from MyFreelap
when you ask — there is no background polling. This is unofficial and may stop working if MyFreelap
changes their site; the app detects this and steers you back to CSV.

## Reviewing a sync

After import, each session appears in the sessions table on the dashboard. Click a session to see
its detail page, then click **Review** to plan the sync.

The review screen shows:

- **Candidate activities** from intervals.icu, ranked by how well they match the session's date and
  duration. Pick one to attach to, or choose **Create new activity** to upload a synthetic recording.
- **A speed-stream chart** (when attaching) with a draggable **offset slider**. The app suggests an
  offset by cross-correlating Freelap rep timings against the watch's speed trace. Adjust the slider
  to align the rep markers with your sprint peaks.
- **A force checkbox** that bypasses the short-circuit when re-syncing an unchanged session.

Click **Sync** to queue the write. The sync runs in the background and takes a few seconds.

## What gets written

When the sync completes, the activity in intervals.icu gains:

| What | Example |
|---|---|
| **Intervals** | `FL #1 · 30m · 3.35s`, `FL #2 · 30m · 3.41s` |
| **Custom fields** | `fl_session_id`, `fl_rep_count`, `fl_best_s`, `fl_avg_s`, `fl_distance_m` |
| **Description block** | A rep table with intermediate splits and max speed, fenced so your own notes are preserved |
| **External ID** | `freelap:<sourceId>`, claimed only if the activity has none |

Interval names are deterministic: a re-sync replaces only the intervals this app owns (those
starting with `FL #`) and leaves everything else alone.

## Verification

After the sync, the app automatically reads the activity back and compares every field against what
was intended. The session detail page shows:

- **Pass** — everything matches.
- **Fail** — one or more fields differ. The page lists each difference so you can decide whether to
  re-sync or investigate.

You can re-verify at any time from the session detail page.

## Re-syncing

If you change the offset or want to force a fresh write, return to the review screen and sync again.
The app detects when the session content has not changed and skips the write (while still
re-verifying). Use the **Force** checkbox to write regardless.

If a session was previously synced and has since drifted (the activity was edited externally), the
next sync will do a full write to bring it back in line.

## Audit log

The **Activity log** page (`/audit`) shows a timestamped record of every action the app has taken on
your behalf: connections, syncs, disconnections, and their outcomes. This is your receipt.

## Deleting your data

- **Disconnect** a service from the dashboard. The stored credentials are deleted immediately.
- **Delete your account** from the dashboard. All your sessions, sync history, credentials, and
  verification records are removed. The audit log is kept without your identity for 2 years.
- Anything already written to intervals.icu stays there — it is yours, in your account.

## Using the CLI

For a single-athlete setup without the web app, you can use the CLI with an intervals.icu API key
(no OAuth app or database needed).

```bash
export INTERVALS_ICU_ATHLETE_ID=i12345
export INTERVALS_ICU_API_KEY=your-key
```

### Import a CSV

```bash
npm run sync -- import ~/Downloads/freelap-export.csv
```

### List imported sessions

```bash
npm run sync -- list
```

### Plan a sync

```bash
npm run sync -- plan csv-7000a729c534
```

Shows candidate activities and a recommended match.

### Push (sync) a session

```bash
npm run sync -- push csv-7000a729c534
```

Flags:
- `--new` — create a new activity instead of attaching
- `--attach a12345` — attach to a specific activity
- `--offset -12` — apply a clock offset in seconds
- `--force` — write even if the content hash has not changed

### Verify a sync

```bash
npm run sync -- verify csv-7000a729c534
```

Reads the activity back and reports any differences.

## Troubleshooting

**"Activity has no recorded data"** — You tried to attach to a watch activity that has no GPS or
sensor streams. The app cannot align rep timings without a time axis. Use **Create new activity**
instead, which uploads a synthetic FIT file with the Freelap timings.

**"Reconnect required"** — Your intervals.icu token has expired and could not be refreshed. Go to
the dashboard and click **Reconnect** to re-authorize.

**"CSRF validation failed"** — Your session may have expired, or the form was submitted from an
unexpected origin. Sign in again and retry.

**Intervals are in the wrong place** — Adjust the offset slider on the review screen. The suggested
offset uses speed-peak correlation, but you can override it. A negative offset shifts reps earlier;
positive shifts them later.

**Duplicate intervals appeared** — This happens if an interval was renamed from `FL #N` to something
else. The app identifies its own intervals by the `FL #` prefix. A future update will add tag-based
identification to prevent this.

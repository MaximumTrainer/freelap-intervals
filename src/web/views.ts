import type { AuditEntry } from '~/audit/audit-log'
import { formatSeconds } from '~/domain/duration'
import type { SprintSession } from '~/domain/sprint-session'
import type { LedgerEntry } from '~/ledger/sync-ledger'
import type { ActivityCandidate } from '~/match/matcher'
import type { VerificationReport } from '~/verify/verifier'

export function escape(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
  :root { color-scheme: light dark; --line: #8883; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 52rem; padding: 2rem 1rem; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid var(--line); padding: .4rem .5rem; text-align: left; }
  .status { font-weight: 600; } .pass { color: #157f3b; } .fail { color: #b3261e; } .partial { color: #9a6700; }
  .muted { opacity: .7; } .card { border: 1px solid var(--line); border-radius: .6rem; padding: 1rem; margin: 1rem 0; }
  button, input[type=submit] { font: inherit; padding: .4rem .9rem; border-radius: .4rem; }
  nav a { margin-right: 1rem; }
`

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Freelap sync</title><style>${STYLE}</style></head>
<body><nav><a href="/">Sessions</a><a href="/audit">Activity log</a></nav><h1>${escape(title)}</h1>${body}</body></html>`
}

export function signInPage(): string {
  return page(
    'Sign in',
    `<form method="post" action="/sign-in" class="card">
       <p>Sign in to sync your Freelap sessions.</p>
       <label>Email <input name="email" type="email" required></label>
       <input type="submit" value="Sign in">
     </form>`,
  )
}

export interface DashboardModel {
  readonly email: string
  readonly intervalsIcuConnected: boolean
  readonly intervalsIcuNeedsReconnect: boolean
  readonly freelapConnected: boolean
  readonly freelapDegraded: boolean
  readonly webAdapterAvailable: boolean
  readonly sessions: ReadonlyArray<{ session: SprintSession; entry: LedgerEntry | null }>
}

export function dashboardPage(model: DashboardModel): string {
  return page('Sessions', [connectionsCard(model), importCard(model), sessionsTable(model)].join('\n'))
}

function connectionsCard(model: DashboardModel): string {
  const intervalsIcu = model.intervalsIcuNeedsReconnect
    ? `<p class="fail">intervals.icu needs reconnecting. <a href="/connect/intervals-icu">Reconnect</a></p>`
    : model.intervalsIcuConnected
      ? `<p class="pass">intervals.icu connected</p>`
      : `<p><a href="/connect/intervals-icu">Connect intervals.icu</a> — we ask only for permission to read
         your activities and write intervals onto them.</p>`

  const degraded = model.freelapDegraded
    ? `<p class="partial">MyFreelap is not answering as it used to, so sessions cannot be fetched for you
         right now. Upload a CSV export instead — that always works.</p>`
    : ''

  const freelap = model.freelapConnected
    ? `${degraded}<p class="pass">MyFreelap connected
         <form method="post" action="/disconnect/myfreelap" style="display:inline">
           <button>Disconnect and delete credentials</button></form></p>`
    : model.webAdapterAvailable
      ? `<form method="post" action="/connect/myfreelap">
           <p class="muted">Optional: store your MyFreelap login so sessions can be fetched for you.
             MyFreelap has no official API, so this may stop working; CSV upload always works.
             Your password is encrypted, never logged, and deleted the moment you disconnect.</p>
           <label>Email <input name="username" type="email" required></label>
           <label>Password <input name="password" type="password" required></label>
           <input type="submit" value="Connect MyFreelap"></form>`
      : ''

  const purge = `<details><summary class="muted">Delete my account and everything in it</summary>
      <form method="post" action="/account/purge">
        <p class="muted">This deletes your sessions, sync history and stored credentials from this app.
          Anything already written to intervals.icu stays there — it is yours.</p>
        <button>Delete everything</button>
      </form></details>`

  return `<section class="card"><h2>Connections</h2><p class="muted">${escape(model.email)}</p>${intervalsIcu}${freelap}${purge}</section>`
}

function importCard(model: DashboardModel): string {
  if (!model.intervalsIcuConnected) return ''

  return `<section class="card"><h2>Import a MyFreelap export</h2>
    <form method="post" action="/sessions/import" enctype="multipart/form-data">
      <input type="file" name="csv" accept=".csv,text/csv" required>
      <input type="submit" value="Import">
    </form></section>`
}

function sessionsTable(model: DashboardModel): string {
  if (model.sessions.length === 0) return '<p class="muted">No sessions imported yet.</p>'

  const rows = model.sessions
    .map(({ session, entry }) => {
      const status = entry ? statusLabel(entry) : '<span class="muted">Not synced</span>'
      return `<tr>
        <td><a href="/sessions/${escape(session.sourceId)}">${escape(session.sourceId)}</a></td>
        <td>${escape(session.startedAt.slice(0, 16).replace('T', ' '))}</td>
        <td>${escape(session.exerciseName)}</td>
        <td>${session.summary.count} reps, best ${escape(formatSeconds(session.summary.bestS))}s</td>
        <td>${status}</td>
        <td><a href="/sessions/${escape(session.sourceId)}/review">Review</a></td>
      </tr>`
    })
    .join('\n')

  return `<h2>Sessions</h2><table><thead><tr>
    <th>Session</th><th>Started</th><th>Exercise</th><th>Reps</th><th>Status</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`
}

export function statusLabel(entry: LedgerEntry): string {
  const wording: Record<LedgerEntry['status'], [string, string]> = {
    pending: ['Queued', 'muted'],
    synced: ['Synced', 'pass'],
    failed: ['Failed', 'fail'],
    drifted: ['Drifted', 'partial'],
  }
  const [text, kind] = wording[entry.status]

  return `<span class="status ${kind}">${text}</span>`
}

export interface ReviewModel {
  readonly session: SprintSession
  readonly candidates: readonly ActivityCandidate[]
  readonly recommendedActivityId: string | null
  readonly needsConfirmation: boolean
  readonly preview: { readonly time: readonly number[]; readonly speed: readonly number[] } | null
  readonly repOffsetsS: readonly number[]
}

export function reviewPage(model: ReviewModel): string {
  const { session } = model

  const candidates = model.candidates
    .map(
      (candidate) => `<label class="card" style="display:block">
        <input type="radio" name="activityId" value="${escape(candidate.activity.id)}"
          ${candidate.activity.id === model.recommendedActivityId ? 'checked' : ''}>
        <strong>${escape(candidate.activity.name)}</strong> · ${escape(candidate.activity.start_date_local)}
        <div class="muted">score ${candidate.score} (${escape(candidate.reasons.join(', '))})</div>
      </label>`,
    )
    .join('\n')

  const preview = model.preview
    ? `<figure data-preview='${escape(JSON.stringify({ ...model.preview, reps: model.repOffsetsS }))}'>
         <svg viewBox="0 0 600 120" width="100%" height="120" role="img" aria-label="Speed with rep markers">
           <polyline id="speed" fill="none" stroke="currentColor" stroke-width="1"></polyline>
           <g id="reps" stroke="#b3261e" stroke-width="2"></g>
         </svg>
         <figcaption class="muted">Watch speed, with the Freelap reps marked. Drag the offset to line them up.</figcaption>
       </figure>`
    : '<p class="muted">This activity has no speed stream to preview against.</p>'

  return page(
    `Review ${session.exerciseName}`,
    `<p class="muted">${escape(session.startedAt)} · ${session.summary.count} reps · best
       ${escape(formatSeconds(session.summary.bestS))}s</p>
     <form method="post" action="/sessions/${escape(session.sourceId)}/sync">
       <h2>Where should this go?</h2>
       ${model.needsConfirmation ? '<p class="partial">More than one activity could be the one — please confirm.</p>' : ''}
       ${candidates || '<p class="muted">Nothing on intervals.icu looks like this session.</p>'}
       <label class="card" style="display:block">
         <input type="radio" name="activityId" value="" ${model.recommendedActivityId === null ? 'checked' : ''}>
         Create a new activity from the Freelap times
       </label>
       <h2>Clock offset</h2>
       <p><input type="range" name="offsetS" min="-120" max="120" step="1" value="0"
            oninput="this.nextElementSibling.textContent = this.value + ' s'"><output>0 s</output></p>
       ${preview}
       <p><input type="submit" value="Sync to intervals.icu"></p>
     </form>
     ${PREVIEW_SCRIPT}`,
  )
}

/** Redraws the stream preview as the athlete drags the offset slider. */
const PREVIEW_SCRIPT = `<script>
  (function () {
    var figure = document.querySelector('[data-preview]')
    if (!figure) return
    var data = JSON.parse(figure.getAttribute('data-preview'))
    var slider = document.querySelector('input[name=offsetS]')
    var speed = document.getElementById('speed')
    var reps = document.getElementById('reps')
    var span = Math.max(1, data.time[data.time.length - 1] || 1)
    var top = Math.max.apply(null, data.speed.concat([1]))
    var x = function (t) { return (t / span) * 600 }
    speed.setAttribute('points', data.time.map(function (t, i) {
      return x(t) + ',' + (120 - (data.speed[i] / top) * 110)
    }).join(' '))
    var draw = function () {
      var offset = Number(slider ? slider.value : 0)
      reps.innerHTML = data.reps.map(function (t) {
        var at = x(t + offset)
        return '<line x1="' + at + '" y1="0" x2="' + at + '" y2="120"></line>'
      }).join('')
    }
    if (slider) slider.addEventListener('input', draw)
    draw()
  })()
</script>`

export interface SessionModel {
  readonly session: SprintSession
  readonly entry: LedgerEntry | null
  readonly verification: VerificationReport | null
}

export function sessionPage(model: SessionModel): string {
  const { session, entry } = model
  const verification = model.verification
    ? `<h2 class="status ${model.verification.status}">Verification: ${model.verification.status}</h2>
       ${diffTable(model.verification)}`
    : ''

  return page(
    session.exerciseName,
    `<p class="muted">${escape(session.sourceId)} · ${escape(session.startedAt)}</p>
     <p>Status: ${entry ? statusLabel(entry) : '<span class="muted">Not synced</span>'}
        ${entry?.activityId ? `· activity <code>${escape(entry.activityId)}</code>` : ''}</p>
     ${entry?.failedStep ? `<p class="fail">Stopped at the ${escape(entry.failedStep)} step.</p>` : ''}
     ${verification}
     <form method="post" action="/sessions/${escape(session.sourceId)}/verify">
       <button ${entry ? '' : 'disabled'}>Re-verify</button>
     </form>
     <p><a href="/sessions/${escape(session.sourceId)}/review">Review and sync again</a></p>`,
  )
}

function diffTable(report: VerificationReport): string {
  if (report.diffs.length === 0) return '<p class="pass">Everything we wrote is exactly as intended.</p>'

  const rows = report.diffs
    .map(
      (diff) =>
        `<tr><td>${escape(diff.check)}</td><td>${escape(diff.expected)}</td><td>${escape(diff.actual)}</td></tr>`,
    )
    .join('\n')

  return `<table><thead><tr><th>Check</th><th>Expected</th><th>Found</th></tr></thead><tbody>${rows}</tbody></table>`
}

export function auditPage(entries: readonly AuditEntry[]): string {
  const rows = entries
    .map(
      (entry) => `<tr>
        <td>${escape(entry.at.slice(0, 19).replace('T', ' '))}</td>
        <td>${escape(entry.action)}</td>
        <td>${escape(entry.target ?? '')}</td>
        <td class="${entry.outcome === 'ok' ? 'pass' : 'fail'}">${escape(entry.outcome)} ${escape(entry.statusCode ?? '')}</td>
      </tr>`,
    )
    .join('\n')

  return page(
    'Activity log',
    `<p class="muted">Every write this app has made to intervals.icu on your behalf.</p>
     <table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Outcome</th></tr></thead>
     <tbody>${rows}</tbody></table>`,
  )
}

export function messagePage(title: string, message: string): string {
  return page(title, `<p>${escape(message)}</p><p><a href="/">Back to your sessions</a></p>`)
}

export interface ColumnMappingModel {
  readonly fingerprint: string
  readonly unmapped: ReadonlyArray<{ readonly header: string }>
}

const MAPPABLE_FIELDS: ReadonlyArray<[string, string]> = [
  ['', 'Ignore this column'],
  ['date', 'Date'],
  ['timeOfDay', 'Time of day'],
  ['athlete', 'Athlete'],
  ['exercise', 'Exercise'],
  ['distanceM', 'Distance (m)'],
  ['repIndex', 'Run number'],
  ['totalS', 'Total time'],
  ['avgSpeed', 'Average speed'],
  ['maxSpeed', 'Max speed'],
]

/** Asks the athlete what the columns we could not place mean, once per export layout. */
export function columnMappingPage(model: ColumnMappingModel): string {
  const headersParam = encodeURIComponent(JSON.stringify(model.unmapped.map((column) => column.header)))
  const options = MAPPABLE_FIELDS.map(
    ([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`,
  ).join('')

  const rows = model.unmapped
    .map(
      (column) => `<p><label>${escape(column.header)}
        <select name="column:${escape(column.header)}">${options}</select></label></p>`,
    )
    .join('\n')

  return page(
    'Unrecognised columns',
    `<p>Your sessions were imported. These columns were not recognised — tell us what they mean and
       we will remember it for the next export with this layout.</p>
     <form method="post" action="/imports/${escape(model.fingerprint)}/columns?headers=${headersParam}">
       ${rows}
       <input type="submit" value="Remember these columns">
     </form>
     <p><a href="/">Skip</a></p>`,
  )
}

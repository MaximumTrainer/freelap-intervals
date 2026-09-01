import type { AuditEntry } from '~/audit/audit-log'
import { formatSeconds } from '~/domain/duration'
import type { SprintSession } from '~/domain/sprint-session'
import type { LedgerEntry } from '~/ledger/sync-ledger'
import type { ActivityCandidate } from '~/match/matcher'
import type { VerificationReport } from '~/verify/verifier'

import type { FreelapConnectionStatus, IcuConnectionStatus } from './connection-probe'

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
  nav { display: flex; align-items: center; } nav a { margin-right: 1rem; } nav form { margin-left: auto; }
`

export interface PageChrome {
  readonly email: string
  readonly csrfToken: string
}

export function page(title: string, body: string, chrome?: PageChrome): string {
  const signOut = chrome
    ? `<form method="post" action="/sign-out" style="display:inline">
         <input type="hidden" name="_csrf" value="${escape(chrome.csrfToken)}">
         <span class="muted">${escape(chrome.email)}</span>
         <button style="margin-left:.5rem">Sign out</button>
       </form>`
    : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Freelap sync</title><style>${STYLE}</style></head>
<body><nav><a href="/">Sessions</a><a href="/audit">Activity log</a>${signOut}</nav><h1>${escape(title)}</h1>${body}</body></html>`
}

export function signInPage(csrfToken: string): string {
  return page(
    'Sign in',
    `<form method="post" action="/sign-in" class="card">
       <input type="hidden" name="_csrf" value="${escape(csrfToken)}">
       <p>Sign in to sync your Freelap sessions.</p>
       <label>Email <input name="email" type="email" required></label>
       <input type="submit" value="Sign in">
     </form>`,
  )
}

export interface DashboardModel {
  readonly email: string
  readonly intervalsIcu: IcuConnectionStatus
  readonly freelap: FreelapConnectionStatus
  readonly webAdapterAvailable: boolean
  readonly oauthScopes: readonly string[]
  readonly sessions: ReadonlyArray<{ session: SprintSession; entry: LedgerEntry | null }>
  readonly csrfToken: string
}

export function dashboardPage(model: DashboardModel): string {
  return page('Sessions', [connectionsCard(model), importCard(model), sessionsTable(model)].join('\n'), {
    email: model.email,
    csrfToken: model.csrfToken,
  })
}

function connectionsCard(model: DashboardModel): string {
  const scopeDetail = `<p class="muted">Scopes requested: <code>${escape(model.oauthScopes.join(' '))}</code>.
    Read finds the activity to attach to; write adds intervals, custom fields and the
    description block. <a href="/privacy">Privacy policy</a>.</p>`

  const intervalsIcu = icuStatusHtml(model.intervalsIcu, scopeDetail)
  const freelap = freelapStatusHtml(model, model.freelap)

  const csrf = `<input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">`
  const purge = `<details><summary class="muted">Delete my account and everything in it</summary>
      <form method="post" action="/account/purge">
        ${csrf}
        <p class="muted">This deletes your sessions, sync history and stored credentials from this app.
          Anything already written to intervals.icu stays there — it is yours.</p>
        <button>Delete everything</button>
      </form></details>`

  return `<section class="card"><h2>Connections</h2><p class="muted">${escape(model.email)}</p>${intervalsIcu}${freelap}${purge}</section>`
}

function icuStatusHtml(status: IcuConnectionStatus, scopeDetail: string): string {
  switch (status.state) {
    case 'not_connected':
      return `<p><a href="/connect/intervals-icu">Connect intervals.icu</a> — we ask only for permission to read
         your activities and write intervals onto them.</p>${scopeDetail}`
    case 'connected':
      return '<p class="pass">intervals.icu connected</p>'
    case 'needs_reconnect':
      return `<p class="fail">intervals.icu needs reconnecting.
        <a href="/connect/intervals-icu">Reconnect</a></p>${scopeDetail}`
    case 'unavailable':
      return `<p class="partial">intervals.icu: ${escape(status.message)}</p>`
  }
}

function freelapStatusHtml(model: DashboardModel, status: FreelapConnectionStatus): string {
  const csrf = `<input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">`

  switch (status.state) {
    case 'connected':
      return `<p class="pass">MyFreelap connected
         <form method="post" action="/disconnect/myfreelap" style="display:inline">
           ${csrf}<button>Disconnect and delete credentials</button></form></p>`
    case 'needs_attention':
      return `<p class="fail">${escape(status.message)}</p>
        <p class="pass">MyFreelap connected
         <form method="post" action="/disconnect/myfreelap" style="display:inline">
           ${csrf}<button>Disconnect and delete credentials</button></form></p>`
    case 'adapter_degraded':
      return `<p class="partial">MyFreelap is not answering as it used to, so sessions cannot be fetched for you
         right now. Upload a CSV export instead — that always works.</p>
        <p class="pass">MyFreelap connected
         <form method="post" action="/disconnect/myfreelap" style="display:inline">
           ${csrf}<button>Disconnect and delete credentials</button></form></p>`
    case 'unavailable':
      return `<p class="partial">MyFreelap: ${escape(status.message)}</p>
        <p class="pass">MyFreelap connected
         <form method="post" action="/disconnect/myfreelap" style="display:inline">
           ${csrf}<button>Disconnect and delete credentials</button></form></p>`
    case 'not_connected':
      return model.webAdapterAvailable
        ? `<form method="post" action="/connect/myfreelap">
           ${csrf}
           <p class="muted">Optional: store your MyFreelap login so sessions can be fetched for you.
             MyFreelap has no official API, so this may stop working; CSV upload always works.
             Your password is encrypted, never logged, and deleted the moment you disconnect.</p>
           <label>Email <input name="username" type="email" required></label>
           <label>Password <input name="password" type="password" required></label>
           <input type="submit" value="Connect MyFreelap"></form>`
        : ''
  }
}

function importCard(model: DashboardModel): string {
  if (model.intervalsIcu.state === 'not_connected') return ''

  return `<section class="card"><h2>Import a MyFreelap export</h2>
    <form method="post" action="/sessions/import" enctype="multipart/form-data">
      <input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">
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
  readonly noStreams?: boolean
  readonly suggestedOffsetS: number | null
  readonly email: string
  readonly csrfToken: string
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
    : model.noStreams
      ? '<p class="fail">This activity has no recorded data to align the reps against.'
        + ' Create a new activity instead.</p>'
      : '<p class="muted">This activity has no speed stream to preview against.</p>'

  return page(
    `Review ${session.exerciseName}`,
    `<p class="muted">${escape(session.startedAt)} · ${session.summary.count} reps · best
       ${escape(formatSeconds(session.summary.bestS))}s</p>
     <form method="post" action="/sessions/${escape(session.sourceId)}/sync">
       <input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">
       <h2>Where should this go?</h2>
       ${model.needsConfirmation ? '<p class="partial">More than one activity could be the one — please confirm.</p>' : ''}
       ${candidates || '<p class="muted">Nothing on intervals.icu looks like this session.</p>'}
       <label class="card" style="display:block">
         <input type="radio" name="activityId" value="" ${model.recommendedActivityId === null ? 'checked' : ''}>
         Create a new activity from the Freelap times
       </label>
       <h2>Clock offset</h2>
       ${offsetSlider(model.suggestedOffsetS)}
       ${preview}
       <p><label><input type="checkbox" name="force" value="true"> Force full write (bypass short-circuit)</label></p>
       <p><input type="submit" value="Sync to intervals.icu"></p>
     </form>
     ${PREVIEW_SCRIPT}`,
    { email: model.email, csrfToken: model.csrfToken },
  )
}

/** Redraws the stream preview as the athlete drags the offset slider. */
function offsetSlider(suggestedS: number | null): string {
  const initial = suggestedS ?? 0
  const hint = suggestedS !== null
    ? 'Suggested from the watch speed trace'
    : 'No suggestion available'

  const oninput = 'this.nextElementSibling.textContent=this.value+\' s\''

  return `<p><input type="range" name="offsetS" min="-120"
    max="120" step="1" value="${initial}"
    oninput="${oninput}"><output>${initial} s</output></p>
  <p class="muted">${hint}</p>`
}

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
  readonly email: string
  readonly csrfToken: string
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
     ${isNoStreamsFail(entry) ? modeBFallback(session, model.csrfToken) : ''}
     ${verification}
     <form method="post" action="/sessions/${escape(session.sourceId)}/verify">
       <input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">
       <button ${entry ? '' : 'disabled'}>Re-verify</button>
     </form>
     <p><a href="/sessions/${escape(session.sourceId)}/review">Review and sync again</a></p>`,
    { email: model.email, csrfToken: model.csrfToken },
  )
}

function isNoStreamsFail(entry: LedgerEntry | null): boolean {
  return entry?.status === 'failed'
    && entry.failedStep === 'intervals'
    && entry.mode === 'attach'
}

function modeBFallback(session: SprintSession, csrfToken: string): string {
  return `<form method="post" action="/sessions/${escape(session.sourceId)}/sync">
    <input type="hidden" name="_csrf" value="${escape(csrfToken)}">
    <input type="hidden" name="activityId" value="">
    <p>That activity has no recorded data to align the reps against.</p>
    <button>Create a new activity instead</button>
  </form>`
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

export function auditPage(entries: readonly AuditEntry[], chrome: PageChrome): string {
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
    chrome,
  )
}

export function messagePage(title: string, message: string): string {
  return page(title, `<p>${escape(message)}</p><p><a href="/">Back to your sessions</a></p>`)
}

export function privacyPage(): string {
  return page(
    'Privacy policy',
    `<p>This app takes sprint sessions you recorded with a Freelap timing system and writes them
       into your own intervals.icu account. It exists to move your data from one place you control
       to another.</p>
     <h2>What we hold</h2>
     <ul>
       <li>Your email address, to sign you in.</li>
       <li>Your intervals.icu tokens, to write sessions on your behalf.</li>
       <li>Your MyFreelap login (optional), to fetch sessions for you.</li>
       <li>Sprint sessions you import and a record of where each was written.</li>
       <li>An audit log of every write we make to intervals.icu.</li>
     </ul>
     <p>We do not sell your data, share it with advertisers, or use it to train anything.</p>
     <h2>Credentials</h2>
     <p>Every credential is encrypted before it reaches the database. Credentials are never logged
       and are redacted if an object holding one is printed.</p>
     <h2>Your control</h2>
     <ul>
       <li>Disconnect either account at any time &mdash; credentials are deleted immediately.</li>
       <li>Delete your account from the connections panel.</li>
       <li>Anything already written to intervals.icu stays there &mdash; it is yours.</li>
     </ul>
     <p><a href="/">Back to your sessions</a></p>`,
  )
}

export interface ColumnMappingModel {
  readonly fingerprint: string
  readonly unmapped: ReadonlyArray<{ readonly header: string }>
  readonly email: string
  readonly csrfToken: string
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
       <input type="hidden" name="_csrf" value="${escape(model.csrfToken)}">
       ${rows}
       <input type="submit" value="Remember these columns">
     </form>
     <p><a href="/">Skip</a></p>`,
    { email: model.email, csrfToken: model.csrfToken },
  )
}

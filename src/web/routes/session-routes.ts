import type { SprintSession } from '~/domain/sprint-session'
import type { SyncChoice } from '~/domain/sync-choice'
import type { CanonicalField, UnmappedColumn } from '~/ingest/csv/column-mapping'
import { inspectCsv } from '~/ingest/csv/csv-adapter'
import { enqueueSync, enqueueVerify } from '~/jobs/sync-jobs'
import type { LedgerEntry } from '~/ledger/sync-ledger'

import type { RequestBody } from '../http'
import { html, redirect } from '../http'
import type { Router } from '../router'
import type { RequestContext } from '../web-app'
import { requireUser } from '../web-app'
import { auditPage, columnMappingPage, dashboardPage, messagePage, reviewPage, sessionPage } from '../views'

/** Importing sessions, reviewing where they should go, syncing them and reading the result. */
export function sessionRoutes(router: Router<RequestContext>): void {
  router.get('/', async (context) => {
    const userId = requireUser(context)
    const { connections, workspaces, flags, users } = context.deps

    const [user, intervalsIcu, freelap] = await Promise.all([
      users.find(userId),
      connections.findIntervalsIcu(userId),
      connections.findFreelap(userId),
    ])

    const workspace = workspaces.forUser(userId)
    const [sessions, entries] = await Promise.all([workspace.sessions.all(), workspace.ledger.all()])
    const bySourceId = new Map(entries.map((entry) => [entry.sourceId, entry]))

    return html(
      dashboardPage({
        email: user?.email ?? '',
        intervalsIcuConnected: intervalsIcu !== null,
        intervalsIcuNeedsReconnect: intervalsIcu?.status === 'needs_reconnect',
        freelapConnected: freelap !== null,
        freelapDegraded: freelap?.status === 'degraded',
        webAdapterAvailable: flags.myfreelapWebAdapter,
        sessions: sessions
          .map((session) => ({ session, entry: bySourceId.get(session.sourceId) ?? null }))
          .sort(newestFirst),
      }),
    )
  })

  router.get('/audit', async (context) => {
    const userId = requireUser(context)

    return html(auditPage(await context.deps.audit.recent(userId)))
  })

  router.post('/sessions/import', async (context) => {
    const userId = requireUser(context)
    const upload = context.body.file('csv')?.text ?? context.body.field('csv')
    if (!upload) return html(messagePage('Nothing imported', 'Choose a CSV export to import.'), 400)

    const remembered = await context.deps.columnMappings.recall(userId, inspectCsv(upload).fingerprint)
    const application = await context.deps.applications.forUser(userId)
    const imported = await application.importCsvExport(upload, remembered)

    if (imported.unmapped.length === 0) return redirect('/')

    return redirect(`/imports/${imported.fingerprint}/columns?headers=${encodeHeaders(imported.unmapped)}`)
  })

  router.get('/imports/:fingerprint/columns', async (context) => {
    requireUser(context)

    return html(
      columnMappingPage({
        fingerprint: context.params.fingerprint ?? '',
        unmapped: decodeHeaders(context.url.searchParams.get('headers')),
      }),
    )
  })

  router.post('/imports/:fingerprint/columns', async (context) => {
    const userId = requireUser(context)
    const unmapped = decodeHeaders(context.url.searchParams.get('headers'))

    await context.deps.columnMappings.remember(
      userId,
      context.params.fingerprint ?? '',
      readMappingForm(context.body, unmapped),
    )

    return redirect('/')
  })

  router.get('/sessions/:sourceId', async (context) => {
    const userId = requireUser(context)
    const workspace = context.deps.workspaces.forUser(userId)
    const session = await workspace.sessions.find(context.params.sourceId ?? '')
    if (!session) return notFound()

    const entry = await workspace.ledger.findBySourceId(session.sourceId)

    return html(sessionPage({ session, entry, verification: entry?.verification ?? null }))
  })

  router.get('/sessions/:sourceId/review', async (context) => {
    const userId = requireUser(context)
    const sourceId = context.params.sourceId ?? ''
    const workspace = context.deps.workspaces.forUser(userId)
    if (!(await workspace.sessions.find(sourceId))) return notFound()

    const application = await context.deps.applications.forUser(userId)
    const plan = await application.planSync(sourceId)
    const preview = await application.previewFor(plan)

    return html(
      reviewPage({
        session: plan.session,
        candidates: plan.candidates,
        recommendedActivityId: plan.recommendation.mode === 'attach' ? plan.recommendation.activityId : null,
        needsConfirmation: plan.needsConfirmation,
        preview: preview.stream,
        repOffsetsS: preview.repOffsetsS,
      }),
    )
  })

  router.post('/sessions/:sourceId/sync', async (context) => {
    const userId = requireUser(context)
    const sourceId = context.params.sourceId ?? ''
    const workspace = context.deps.workspaces.forUser(userId)
    const session = await workspace.sessions.find(sourceId)
    if (!session) return notFound()

    const activityId = context.body.field('activityId')?.trim()
    const choice: SyncChoice = activityId ? { mode: 'attach', activityId } : { mode: 'create-new' }
    const offsetS = Number(context.body.field('offsetS') ?? 0)

    await workspace.ledger.save(queuedEntry(session, choice, activityId ?? ''))
    await enqueueSync(context.deps.queue, {
      userId,
      sourceId,
      choice,
      ...(Number.isFinite(offsetS) && offsetS !== 0 ? { offsetS } : {}),
    })

    return redirect(`/sessions/${sourceId}`)
  })

  router.post('/sessions/:sourceId/verify', async (context) => {
    const userId = requireUser(context)
    const sourceId = context.params.sourceId ?? ''
    if (!(await context.deps.workspaces.forUser(userId).sessions.find(sourceId))) return notFound()

    await enqueueVerify(context.deps.queue, { userId, sourceId })

    return redirect(`/sessions/${sourceId}`)
  })
}

function queuedEntry(session: SprintSession, choice: SyncChoice, activityId: string): LedgerEntry {
  return {
    sourceId: session.sourceId,
    activityId,
    mode: choice.mode,
    status: 'pending',
    contentHash: '',
    syncedAt: new Date().toISOString(),
  }
}

/** The unrecognised headers travel in the URL, so the export itself never has to be stored. */
function encodeHeaders(unmapped: readonly UnmappedColumn[]): string {
  return encodeURIComponent(JSON.stringify(unmapped.map((column) => column.header)))
}

function decodeHeaders(encoded: string | null): UnmappedColumn[] {
  if (!encoded) return []

  try {
    const headers = JSON.parse(encoded) as unknown
    if (!Array.isArray(headers)) return []

    return headers.map((header, column) => ({ column, header: String(header) }))
  } catch {
    return []
  }
}

function readMappingForm(body: RequestBody, unmapped: readonly UnmappedColumn[]): Record<string, CanonicalField> {
  const mapping: Record<string, CanonicalField> = {}

  for (const column of unmapped) {
    const field = body.field(`column:${column.header}`)
    if (field) mapping[column.header] = field as CanonicalField
  }

  return mapping
}

function newestFirst(left: { session: SprintSession }, right: { session: SprintSession }): number {
  return Date.parse(right.session.startedAt) - Date.parse(left.session.startedAt)
}

function notFound() {
  return html(messagePage('Not found', 'There is no such session in your account.'), 404)
}

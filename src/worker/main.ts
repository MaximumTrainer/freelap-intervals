import process from 'node:process'

import { buildRuntime, configFromEnvironment, registerSchedules } from '~/config'
import { canaryJobHandlers } from '~/jobs/canary-job'
import { retentionJobHandlers } from '~/jobs/retention-job'
import { syncJobHandlers } from '~/jobs/sync-jobs'
import { Worker } from '~/jobs/worker'

const IDLE_PAUSE_MS = 1000

/** `npm run worker` — drains the queue, forever, until it is asked to stop. */
async function main(): Promise<void> {
  const runtime = buildRuntime(configFromEnvironment())
  const logger = runtime.logger
  const alerts = runtime.alertGate
  const worker = new Worker(
    runtime.queue,
    {
      ...syncJobHandlers(runtime.applications, runtime.metrics),
      ...canaryJobHandlers(runtime.adapterHealth, runtime.canarySource, runtime.web.audit, alerts),
      ...retentionJobHandlers(runtime.database, {}, runtime.metrics),
    },
    {
      onRetry: (job, delayMs, error) =>
        logger.warn('job retrying', { jobId: job.id, kind: job.kind, delayMs, error: error.message }),
      onFailure: (job, error) => {
        logger.error('job failed permanently', { jobId: job.id, kind: job.kind, error: error.message })
        runtime.web.errorReporter.report(error, { jobId: job.id, jobKind: job.kind })
        void alerts.fire(`job-failed:${job.kind}:${job.id}`, {
          severity: 'warning',
          title: `Job failed: ${job.kind}`,
          detail: { jobId: job.id, kind: job.kind, error: error.message },
        })
        void alerts.trackFailure(job.kind)
      },
    },
  )

  let running = true
  const stop = (): void => {
    running = false
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await registerSchedules(runtime.config, runtime.scheduler)
  logger.info('Freelap sync worker started')

  while (running) {
    await runtime.scheduler.tick()
    const did = await worker.runOnce()
    if (!did) await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS))
  }

  await runtime.close()
}

main().catch((error: unknown) => {
  process.stderr.write(`The worker stopped: ${(error as Error).message}\n`)
  process.exitCode = 1
})

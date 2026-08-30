import process from 'node:process'

import { buildRuntime, configFromEnvironment } from '~/config'
import { canaryJobHandlers } from '~/jobs/canary-job'
import { syncJobHandlers } from '~/jobs/sync-jobs'
import { Worker } from '~/jobs/worker'

const IDLE_PAUSE_MS = 1000

/** `npm run worker` — drains the queue, forever, until it is asked to stop. */
async function main(): Promise<void> {
  const runtime = buildRuntime(configFromEnvironment())
  const worker = new Worker(
    runtime.queue,
    { ...syncJobHandlers(runtime.applications), ...canaryJobHandlers(runtime.connections, runtime.sources, runtime.web.audit) },
    {
      onRetry: (job, delayMs, error) =>
        console.warn(`${job.kind} #${job.id} failed (${error.message}); retrying in ${Math.round(delayMs / 1000)}s`),
      onFailure: (job, error) => console.error(`${job.kind} #${job.id} gave up: ${error.message}`),
    },
  )

  let running = true
  const stop = (): void => {
    running = false
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  console.log('Freelap sync worker started')

  while (running) {
    const did = await worker.runOnce()
    if (!did) await new Promise((resolve) => setTimeout(resolve, IDLE_PAUSE_MS))
  }

  await runtime.close()
}

main().catch((error: unknown) => {
  console.error(`The worker stopped: ${(error as Error).message}`)
  process.exitCode = 1
})

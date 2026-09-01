import { createServer } from 'node:http'
import process from 'node:process'

import { buildRuntime, configFromEnvironment } from '~/config'

import { createWebApp } from './web-app'

/** `npm run web` — serves the app. */
async function main(): Promise<void> {
  const runtime = buildRuntime(configFromEnvironment())
  const server = createServer(createWebApp(runtime.web))

  server.listen(runtime.config.port, () => {
    runtime.logger.info('Freelap sync listening', { port: runtime.config.port })
  })

  const shutDown = (): void => {
    server.close(() => void runtime.close().then(() => process.exit(0)))
  }
  process.on('SIGINT', shutDown)
  process.on('SIGTERM', shutDown)
}

main().catch((error: unknown) => {
  process.stderr.write(`The web app could not start: ${(error as Error).message}\n`)
  process.exitCode = 1
})

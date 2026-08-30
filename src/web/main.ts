import { createServer } from 'node:http'
import process from 'node:process'

import { buildRuntime, configFromEnvironment } from '~/config'

import { createWebApp } from './web-app'

/** `npm run web` — serves the app. */
async function main(): Promise<void> {
  const runtime = buildRuntime(configFromEnvironment())
  const server = createServer(createWebApp(runtime.web))

  server.listen(runtime.config.port, () => {
    console.log(`Freelap sync listening on http://localhost:${runtime.config.port}`)
  })

  const shutDown = (): void => {
    server.close(() => void runtime.close().then(() => process.exit(0)))
  }
  process.on('SIGINT', shutDown)
  process.on('SIGTERM', shutDown)
}

main().catch((error: unknown) => {
  console.error(`The web app could not start: ${(error as Error).message}`)
  process.exitCode = 1
})

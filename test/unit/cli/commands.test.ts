import { describe, expect, it } from 'vitest'

import { runCommand } from '~/cli/commands'
import type { CliDependencies } from '~/cli/commands'

import { csvFixture } from '../../support/fixtures'
import { oneHzStreams } from '../../support/streams'
import { aTestApp } from '../../support/test-app'

function aCli() {
  const { app, icu, ledger } = aTestApp()
  const lines: string[] = []
  const deps: CliDependencies = {
    app,
    readFile: async (path: string) => csvFixture(path),
    out: (line) => lines.push(line),
  }

  return {
    icu,
    ledger,
    lines,
    printed: (): string => lines.join('\n'),
    run: (...argv: string[]) => runCommand(argv, deps),
  }
}

describe('freelap-sync import', () => {
  it('imports a CSV export and lists what it found', async () => {
    const cli = aCli()

    const code = await cli.run('import', 'two-sessions.csv')

    expect(code).toBe(0)
    expect(cli.printed()).toContain('Imported 3 sessions')
    expect(cli.printed()).toContain('Flying 30m')
    expect(cli.printed()).toContain('60m from blocks')
  })

  it('explains what went wrong with an unreadable export', async () => {
    const cli = aCli()

    const code = await runCommand(['import', 'broken.csv'], {
      app: aTestApp().app,
      readFile: async () => 'Date;Athlete\n29/08/2026;Dan',
      out: (line) => cli.lines.push(line),
    })

    expect(code).toBe(1)
    expect(cli.printed()).toMatch(/no total time column/i)
  })
})

describe('freelap-sync plan', () => {
  it('shows the candidate activities and what it recommends', async () => {
    const cli = aCli()
    cli.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())

    await cli.run('plan', sourceId!)

    expect(cli.printed()).toContain('Morning Run')
    expect(cli.printed()).toContain('same day, same sport, overlaps the session')
    expect(cli.printed()).toMatch(/Recommended: attach to a1/)
  })
})

describe('freelap-sync push', () => {
  it('creates a new activity and reports the verification', async () => {
    const cli = aCli()
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())

    const code = await cli.run('push', sourceId!, '--new')

    expect(code).toBe(0)
    expect(cli.printed()).toContain('Wrote 6 reps to activity a1')
    expect(cli.printed()).toContain('Verification: pass')
    expect(cli.icu.intervalsOf('a1')).toHaveLength(6)
  })

  it('follows the recommendation when the match is unambiguous', async () => {
    const cli = aCli()
    cli.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())

    await cli.run('push', sourceId!)

    expect(cli.icu.activityCount).toBe(1)
    expect(cli.icu.intervalsOf('a1')).toHaveLength(6)
  })

  it('refuses to guess when the candidates are ambiguous', async () => {
    const cli = aCli()
    cli.icu.givenActivity({ start_date_local: '2026-08-29T10:10:00', name: 'Morning Run' }, oneHzStreams(1200))
    cli.icu.givenActivity({ start_date_local: '2026-08-29T10:11:00', name: 'Morning Run' }, oneHzStreams(1200))
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())

    const code = await cli.run('push', sourceId!)

    expect(code).toBe(1)
    expect(cli.printed()).toMatch(/needs confirmation/i)
    expect(cli.icu.intervalsOf('a1')).toEqual([])
  })

  it('reports a failed write against the step it stopped at', async () => {
    const cli = aCli()
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())
    cli.icu.failNextCallWith(500, 'upload exploded')

    const code = await cli.run('push', sourceId!, '--new')

    expect(code).toBe(1)
    expect(cli.printed()).toContain('Sync failed at the activity step')
    expect(await cli.ledger.findBySourceId(sourceId!)).toMatchObject({ status: 'failed', failedStep: 'activity' })
  })
})

describe('freelap-sync verify', () => {
  it('re-checks a synced session and lists the differences it finds', async () => {
    const cli = aCli()
    await cli.run('import', 'flying-30m-semicolon.csv')
    const [sourceId] = sourceIdsIn(cli.printed())
    await cli.run('push', sourceId!, '--new')
    await cli.icu.putIntervals('a1', [])

    const code = await cli.run('verify', sourceId!)

    expect(code).toBe(1)
    expect(cli.printed()).toContain('Verification: fail')
    expect(cli.printed()).toContain('interval count: expected 6, found 0')
  })
})

describe('freelap-sync usage', () => {
  it('prints the commands it understands when asked for something else', async () => {
    const cli = aCli()

    expect(await cli.run('frobnicate')).toBe(1)
    expect(cli.printed()).toContain('Usage: freelap-sync')
  })
})

function sourceIdsIn(output: string): string[] {
  return [...output.matchAll(/csv-[0-9a-f]{12}/g)].map(([id]) => id)
}

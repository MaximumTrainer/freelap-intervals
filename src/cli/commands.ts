import type { SyncApplication } from '~/app/sync-application'
import { formatSeconds } from '~/domain/duration'
import type { SprintSession } from '~/domain/sprint-session'
import type { SyncChoice } from '~/domain/sync-choice'
import type { ActivityCandidate } from '~/match/matcher'
import type { VerificationReport } from '~/verify/verifier'

export interface CliDependencies {
  readonly app: SyncApplication
  readonly readFile: (path: string) => Promise<string>
  readonly out: (line: string) => void
}

const USAGE = [
  'Usage: freelap-sync <command>',
  '',
  '  import <file.csv>                     read a MyFreelap export and remember its sessions',
  '  list                                  show the sessions imported so far',
  '  plan <session-id>                     show where the session could be written',
  '  push <session-id> [options]           write the session to intervals.icu and verify it',
  '        --new                           always create a new activity',
  '        --attach <activity-id>          attach to that activity',
  '        --offset <seconds>              shift every rep to correct for clock drift',
  '  verify <session-id>                   re-check a synced session against intervals.icu',
].join('\n')

const OK = 0
const FAILED = 1

/** Maps a command line onto the application's use cases. Every command reports its own exit code. */
export async function runCommand(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const [command, ...rest] = argv

  try {
    switch (command) {
      case 'import':
        return await importCsv(rest, deps)
      case 'list':
        return await listSessions(deps)
      case 'plan':
        return await showPlan(rest, deps)
      case 'push':
        return await push(rest, deps)
      case 'verify':
        return await verify(rest, deps)
      default:
        deps.out(USAGE)
        return FAILED
    }
  } catch (error) {
    deps.out(`Error: ${(error as Error).message}`)
    return FAILED
  }
}

async function importCsv(args: readonly string[], deps: CliDependencies): Promise<number> {
  const path = required(args[0], 'a CSV file to import')
  const sessions = await deps.app.importCsv(await deps.readFile(path))

  deps.out(`Imported ${sessions.length} ${plural(sessions.length, 'session')} from ${path}`)
  for (const session of sessions) deps.out(`  ${describeSession(session)}`)

  return OK
}

async function listSessions(deps: CliDependencies): Promise<number> {
  const sessions = await deps.app.importedSessions()
  if (sessions.length === 0) deps.out('No sessions imported yet.')

  for (const session of sessions) deps.out(describeSession(session))

  return OK
}

async function showPlan(args: readonly string[], deps: CliDependencies): Promise<number> {
  const plan = await deps.app.planSync(required(args[0], 'a session id'))

  deps.out(describeSession(plan.session))
  if (plan.previousSync) deps.out(`  last synced to ${plan.previousSync.activityId} (${plan.previousSync.status})`)

  if (plan.candidates.length === 0) deps.out('  no candidate activities within a day of this session')
  for (const candidate of plan.candidates) deps.out(`  ${describeCandidate(candidate)}`)

  deps.out(`  Recommended: ${describeChoice(plan.recommendation)}${plan.needsConfirmation ? ' (needs confirmation)' : ''}`)

  return OK
}

async function push(args: readonly string[], deps: CliDependencies): Promise<number> {
  const sourceId = required(args[0], 'a session id')
  const options = parseOptions(args.slice(1))
  const session = await deps.app.findSession(sourceId)
  if (!session) throw new Error(`No imported session with id ${sourceId}`)

  const choice = await chosenTarget(options, sourceId, deps)
  if (!choice) return FAILED

  const outcome = await deps.app.sync(sourceId, choice, options.offsetS === null ? {} : { offsetS: options.offsetS })

  deps.out(`Wrote ${session.reps.length} reps to activity ${outcome.activityId} (${outcome.mode})`)
  return reportVerification(outcome.verification, deps)
}

async function verify(args: readonly string[], deps: CliDependencies): Promise<number> {
  return reportVerification(await deps.app.verify(required(args[0], 'a session id')), deps)
}

function reportVerification(report: VerificationReport, deps: CliDependencies): number {
  deps.out(`Verification: ${report.status}`)
  for (const diff of report.diffs) deps.out(`  ${diff.check}: expected ${diff.expected}, found ${diff.actual}`)

  return report.status === 'pass' ? OK : FAILED
}

interface PushOptions {
  readonly attachTo: string | null
  readonly createNew: boolean
  readonly offsetS: number | null
}

function parseOptions(args: readonly string[]): PushOptions {
  const valueAfter = (flag: string): string | null => {
    const at = args.indexOf(flag)
    return at === -1 ? null : required(args[at + 1], `a value after ${flag}`)
  }

  const offset = valueAfter('--offset')

  return {
    attachTo: valueAfter('--attach'),
    createNew: args.includes('--new'),
    offsetS: offset === null ? null : Number(offset),
  }
}

/** Never writes on a guess: an ambiguous match must be settled by the athlete. */
async function chosenTarget(
  options: PushOptions,
  sourceId: string,
  deps: CliDependencies,
): Promise<SyncChoice | null> {
  if (options.attachTo) return { mode: 'attach', activityId: options.attachTo }
  if (options.createNew) return { mode: 'create-new' }

  const plan = await deps.app.planSync(sourceId)
  if (!plan.needsConfirmation) return plan.recommendation

  deps.out(`This session needs confirmation before writing: ${plan.candidates.length} candidate activities.`)
  for (const candidate of plan.candidates) deps.out(`  ${describeCandidate(candidate)}`)
  deps.out('Re-run with --attach <activity-id> or --new.')

  return null
}

function describeSession(session: SprintSession): string {
  const distance = session.distanceM === null ? '' : ` · ${session.distanceM}m`

  return [
    session.sourceId,
    session.startedAt.slice(0, 16).replace('T', ' '),
    `${session.exerciseName}${distance}`,
    `${session.summary.count} ${plural(session.summary.count, 'rep')}`,
    `best ${formatSeconds(session.summary.bestS)}s`,
  ].join('  ')
}

function describeCandidate(candidate: ActivityCandidate): string {
  const { activity } = candidate

  return `${activity.id}  ${activity.start_date_local}  ${activity.name}  score ${candidate.score} (${candidate.reasons.join(', ')})`
}

function describeChoice(choice: SyncChoice): string {
  return choice.mode === 'attach' ? `attach to ${choice.activityId}` : 'create a new activity'
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Expected ${what}`)
  return value
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

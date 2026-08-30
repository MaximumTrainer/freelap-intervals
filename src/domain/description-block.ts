import { createHash } from 'node:crypto'

import { formatSeconds } from './duration'
import type { Rep, SprintSession } from './sprint-session'
import { mpsToKmh, roundTo } from './units'

export const BLOCK_START = '<!-- freelap:start -->'
export const BLOCK_END = '<!-- freelap:end -->'

const BLOCK = /<!-- freelap:start -->[\s\S]*?<!-- freelap:end -->/
const ABSENT = '–'

/**
 * Renders the human-readable rep table that goes into the activity description, fenced by
 * markers so a re-sync replaces only this block and leaves the athlete's own notes intact.
 */
export function renderFreelapBlock(session: SprintSession): string {
  const splitDistances = intermediateSplitDistances(session)
  const showsMaxSpeed = session.reps.some((rep) => rep.maxSpeedMps !== null)

  const header = ['Rep', 'Time (s)', ...splitDistances.map((atM) => `${atM}m (s)`), ...(showsMaxSpeed ? ['Max (km/h)'] : [])]
  const rows = session.reps.map((rep) => repRow(rep, splitDistances, showsMaxSpeed))

  return [
    BLOCK_START,
    `### Freelap · ${session.exerciseName}`,
    summaryLine(session),
    '',
    toRow(header),
    toRow(header.map(() => '---')),
    ...rows.map(toRow),
    BLOCK_END,
  ].join('\n')
}

function summaryLine(session: SprintSession): string {
  const { count, bestS, avgS } = session.summary
  const parts = [
    `${count} ${count === 1 ? 'rep' : 'reps'}`,
    `best ${formatSeconds(bestS)}s`,
    `avg ${formatSeconds(avgS)}s`,
    session.distanceM === null ? null : `${session.distanceM}m`,
  ]

  return parts.filter((part) => part !== null).join(' · ')
}

function repRow(rep: Rep, splitDistances: readonly number[], showsMaxSpeed: boolean): string[] {
  const splitAt = (atM: number): string => {
    const split = rep.splits.find((candidate) => candidate.atM === atM)
    return split ? formatSeconds(split.elapsedS) : ABSENT
  }

  return [
    String(rep.index),
    formatSeconds(rep.totalS),
    ...splitDistances.map(splitAt),
    ...(showsMaxSpeed ? [rep.maxSpeedMps === null ? ABSENT : String(roundTo(mpsToKmh(rep.maxSpeedMps), 1))] : []),
  ]
}

/** The split taken at the full distance repeats the total time, so it earns no column. */
function intermediateSplitDistances(session: SprintSession): number[] {
  const distances = session.reps.flatMap((rep) =>
    rep.splits
      .filter((split) => {
        const fullDistance = rep.distanceM ?? session.distanceM
        return fullDistance === null || split.atM < fullDistance
      })
      .map((split) => split.atM),
  )

  return [...new Set(distances)].sort((left, right) => left - right)
}

function toRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`
}

export function applyFreelapBlock(description: string | null | undefined, block: string): string {
  const existing = description?.trim() ?? ''
  if (existing === '') return block
  if (BLOCK.test(existing)) return existing.replace(BLOCK, block)

  return `${existing}\n\n${block}`
}

export function extractFreelapBlock(description: string | null | undefined): string | null {
  return BLOCK.exec(description ?? '')?.[0] ?? null
}

export function blockHash(block: string | null): string | null {
  return block === null ? null : createHash('sha256').update(block).digest('hex').slice(0, 12)
}

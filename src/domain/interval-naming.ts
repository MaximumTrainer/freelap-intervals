import { formatSeconds } from './duration'
import type { Rep, SprintSession } from './sprint-session'

const SEPARATOR = ' · '
const OWNED_INTERVAL = /^FL #\d+(?:\s|$)/

/**
 * Interval names are deterministic so a re-sync can find, and safely replace, exactly the
 * intervals this integration owns — and nothing the athlete added by hand.
 */
export function intervalNameFor(session: SprintSession, rep: Rep): string {
  const distanceM = rep.distanceM ?? session.distanceM
  const segments = [`FL #${rep.index}`, distanceM === null ? null : `${distanceM}m`, `${formatSeconds(rep.totalS)}s`]

  return segments.filter((segment) => segment !== null).join(SEPARATOR)
}

export function isFreelapInterval(name: string | undefined | null): boolean {
  return OWNED_INTERVAL.test(name ?? '')
}

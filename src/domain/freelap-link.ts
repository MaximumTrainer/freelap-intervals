import type { SprintSession } from './sprint-session'

const EXTERNAL_ID_PREFIX = 'freelap:'

/** How an intervals.icu activity says which Freelap session it carries. */
export function externalIdFor(session: SprintSession): string {
  return `${EXTERNAL_ID_PREFIX}${session.sourceId}`
}

export function freelapSessionIdIn(externalId: string | null | undefined): string | null {
  return externalId?.startsWith(EXTERNAL_ID_PREFIX) ? externalId.slice(EXTERNAL_ID_PREFIX.length) : null
}

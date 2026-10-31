import type { SprintSession } from '~/domain/sprint-session'
import type { CustomFieldDefinition, CustomFieldValues } from '~/icu/intervals-icu-client'

/** Created once per athlete, then written on every synced activity. */
export const FREELAP_CUSTOM_FIELDS: readonly CustomFieldDefinition[] = [
  { code: 'FlSessionId', name: 'Freelap session', type: 'TEXT' },
  { code: 'FlRepCount', name: 'Freelap reps', type: 'NUMBER' },
  { code: 'FlBestS', name: 'Freelap best (s)', type: 'NUMBER' },
  { code: 'FlAvgS', name: 'Freelap average (s)', type: 'NUMBER' },
  { code: 'FlDistanceM', name: 'Freelap rep distance (m)', type: 'NUMBER' },
]

export function customFieldValuesFor(session: SprintSession): CustomFieldValues {
  return {
    FlSessionId: session.sourceId,
    FlRepCount: session.summary.count,
    FlBestS: session.summary.bestS,
    FlAvgS: session.summary.avgS,
    ...(session.distanceM === null ? {} : { FlDistanceM: session.distanceM }),
  }
}

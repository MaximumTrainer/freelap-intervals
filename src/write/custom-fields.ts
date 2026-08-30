import type { SprintSession } from '~/domain/sprint-session'
import type { CustomFieldDefinition, CustomFieldValues } from '~/icu/intervals-icu-client'

/** Created once per athlete, then written on every synced activity. */
export const FREELAP_CUSTOM_FIELDS: readonly CustomFieldDefinition[] = [
  { code: 'fl_session_id', name: 'Freelap session', type: 'TEXT' },
  { code: 'fl_rep_count', name: 'Freelap reps', type: 'NUMBER' },
  { code: 'fl_best_s', name: 'Freelap best (s)', type: 'NUMBER' },
  { code: 'fl_avg_s', name: 'Freelap average (s)', type: 'NUMBER' },
  { code: 'fl_distance_m', name: 'Freelap rep distance (m)', type: 'NUMBER' },
]

export function customFieldValuesFor(session: SprintSession): CustomFieldValues {
  return {
    fl_session_id: session.sourceId,
    fl_rep_count: session.summary.count,
    fl_best_s: session.summary.bestS,
    fl_avg_s: session.summary.avgS,
    ...(session.distanceM === null ? {} : { fl_distance_m: session.distanceM }),
  }
}

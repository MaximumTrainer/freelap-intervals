/**
 * Raw MyFreelap API payload builders for testing the validation layer.
 * Good shapes match what {@link FakeMyFreelapApi} serves; callers mutate
 * them to simulate schema drift. When B1 lands real captures, add them here.
 */

export function aPayloadRun(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: '2026-08-29T10:14:03',
    time_s: 3.42,
    avg_speed_kmh: 31.6,
    max_speed_kmh: 33.4,
    splits: [
      { distance_m: 10, time_s: 1.21 },
      { distance_m: 30, time_s: 3.42 },
    ],
    ...overrides,
  }
}

export function aPayloadSessionDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '77123',
    name: 'Flying 30m',
    athlete: 'Dan Wood',
    distance_m: 30,
    runs: [aPayloadRun()],
    ...overrides,
  }
}

export function aPayloadListEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: '77123',
    date: '2026-08-29T10:14:03',
    name: 'Flying 30m',
    athlete: 'Dan Wood',
    distance_m: 30,
    run_count: 6,
    best_time_s: 3.35,
    ...overrides,
  }
}

export function aPayloadSessionList(
  sessions?: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return { sessions: sessions ?? [aPayloadListEntry()] }
}

/** Shallow copy of `obj` with `key` removed. */
export function without(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => k !== key),
  )
}

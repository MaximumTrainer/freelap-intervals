import type { IcuStreams } from '~/icu/intervals-icu-client'

/** A watch recording sampled once a second, as intervals.icu serves streams. */
export function oneHzStreams(durationS: number): IcuStreams {
  const time = Array.from({ length: durationS + 1 }, (_, second) => second)

  return { time, distance: time.map((second) => second * 3), velocity_smooth: time.map(() => 3) }
}

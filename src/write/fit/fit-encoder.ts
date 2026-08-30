import type { TimelineLap, TimelineRecord } from '~/write/session-timeline'

import type { FieldSpec, FitSport, MessageSpec } from './fit-format'
import {
  ACTIVITY,
  BASE_TYPES,
  EVENT_ACTIVITY,
  EVENT_LAP,
  EVENT_SESSION,
  EVENT_TYPE_STOP,
  FILE_ID,
  FILE_TYPE_ACTIVITY,
  LAP,
  RECORD,
  SESSION,
  SPORT_CODES,
  SUB_SPORT_TRACK,
  crc16,
  toFitTimestamp,
} from './fit-format'

export interface FitActivityInput {
  readonly startEpochMs: number
  readonly sport: FitSport
  readonly durationS: number
  readonly totalDistanceM: number
  readonly records: readonly TimelineRecord[]
  readonly laps: readonly TimelineLap[]
}

const HEADER_SIZE = 14
const PROTOCOL_VERSION = 0x20
const PROFILE_VERSION = 2140
const MANUFACTURER_DEVELOPMENT = 255
const LOCAL = { fileId: 0, record: 1, lap: 2, session: 3, activity: 4 } as const

type FieldValues = Readonly<Record<string, number | null>>

/**
 * Builds a FIT activity file for a session that was never recorded by a watch: one lap per
 * rep, a sparse record stream that rests at zero speed between reps, and a track-running
 * session summary.
 */
export function encodeFitActivity(input: FitActivityInput): Uint8Array {
  const body = new FitBody()
  const at = (offsetS: number): number => toFitTimestamp(input.startEpochMs + offsetS * 1000)
  const endTimestamp = at(input.durationS)

  body.define(LOCAL.fileId, FILE_ID)
  body.write(LOCAL.fileId, FILE_ID, {
    type: FILE_TYPE_ACTIVITY,
    manufacturer: MANUFACTURER_DEVELOPMENT,
    product: 1,
    serialNumber: 1,
    timeCreated: at(0),
  })

  body.define(LOCAL.record, RECORD)
  for (const record of input.records) {
    body.write(LOCAL.record, RECORD, recordFields(record, at))
  }

  body.define(LOCAL.lap, LAP)
  input.laps.forEach((lap, index) => body.write(LOCAL.lap, LAP, lapFields(lap, index, at)))

  body.define(LOCAL.session, SESSION)
  body.write(LOCAL.session, SESSION, {
    messageIndex: 0,
    timestamp: endTimestamp,
    startTime: at(0),
    totalElapsedTime: input.durationS,
    totalTimerTime: input.durationS,
    totalDistance: input.totalDistanceM,
    sport: SPORT_CODES[input.sport],
    subSport: SUB_SPORT_TRACK,
    firstLapIndex: 0,
    numLaps: input.laps.length,
    event: EVENT_SESSION,
    eventType: EVENT_TYPE_STOP,
  })

  body.define(LOCAL.activity, ACTIVITY)
  body.write(LOCAL.activity, ACTIVITY, {
    timestamp: endTimestamp,
    totalTimerTime: input.durationS,
    numSessions: 1,
    type: 0,
    event: EVENT_ACTIVITY,
    eventType: EVENT_TYPE_STOP,
  })

  return sealed(body.bytes())
}

function recordFields(record: TimelineRecord, at: (offsetS: number) => number): FieldValues {
  return { timestamp: at(record.offsetS), distance: record.distanceM, speed: record.speedMps }
}

function lapFields(lap: TimelineLap, index: number, at: (offsetS: number) => number): FieldValues {
  return {
    messageIndex: index,
    timestamp: at(lap.endS),
    startTime: at(lap.startS),
    totalElapsedTime: lap.endS - lap.startS,
    totalTimerTime: lap.endS - lap.startS,
    totalDistance: lap.distanceM,
    avgSpeed: lap.avgSpeedMps,
    maxSpeed: lap.maxSpeedMps,
    event: EVENT_LAP,
    eventType: EVENT_TYPE_STOP,
  }
}

class FitBody {
  private readonly written: number[] = []

  define(localType: number, spec: MessageSpec): void {
    const fields = Object.values(spec.fields)

    this.written.push(0x40 | localType, 0, 0)
    this.pushUint(spec.globalNum, 2)
    this.written.push(fields.length)

    for (const field of fields) {
      this.written.push(field.num, BASE_TYPES[field.base].size, BASE_TYPES[field.base].id)
    }
  }

  write(localType: number, spec: MessageSpec, values: FieldValues): void {
    this.written.push(localType)

    for (const [name, field] of Object.entries(spec.fields)) {
      this.pushUint(encodeValue(values[name], field), BASE_TYPES[field.base].size)
    }
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.written)
  }

  private pushUint(value: number, size: number): void {
    for (let byte = 0; byte < size; byte += 1) {
      this.written.push((value >>> (byte * 8)) & 0xff)
    }
  }
}

function encodeValue(value: number | null | undefined, field: FieldSpec): number {
  const base = BASE_TYPES[field.base]
  if (value === null || value === undefined || !Number.isFinite(value)) return base.invalid

  const scaled = Math.round(value * (field.scale ?? 1))
  return scaled < 0 || scaled >= base.invalid ? base.invalid : scaled
}

function sealed(body: Uint8Array): Uint8Array {
  const file = new Uint8Array(HEADER_SIZE + body.length + 2)
  const view = new DataView(file.buffer)

  file[0] = HEADER_SIZE
  file[1] = PROTOCOL_VERSION
  view.setUint16(2, PROFILE_VERSION, true)
  view.setUint32(4, body.length, true)
  file.set([0x2e, 0x46, 0x49, 0x54], 8) // ".FIT"
  view.setUint16(12, crc16(file.subarray(0, 12)), true)

  file.set(body, HEADER_SIZE)
  view.setUint16(file.length - 2, crc16(file.subarray(0, file.length - 2)), true)

  return file
}

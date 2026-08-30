/** The slice of the FIT profile this integration needs to write a track session. */

export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31)

export type BaseTypeName = 'enum' | 'uint8' | 'uint16' | 'uint32'

export interface BaseType {
  readonly id: number
  readonly size: number
  readonly invalid: number
}

export const BASE_TYPES: Readonly<Record<BaseTypeName, BaseType>> = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
}

const BY_ID = new Map(Object.values(BASE_TYPES).map((type) => [type.id, type]))

export function baseTypeById(id: number): BaseType | undefined {
  return BY_ID.get(id)
}

export interface FieldSpec {
  readonly num: number
  readonly base: BaseTypeName
  readonly scale?: number
}

export interface MessageSpec {
  readonly globalNum: number
  readonly fields: Readonly<Record<string, FieldSpec>>
}

export const FILE_ID: MessageSpec = {
  globalNum: 0,
  fields: {
    type: { num: 0, base: 'enum' },
    manufacturer: { num: 1, base: 'uint16' },
    product: { num: 2, base: 'uint16' },
    serialNumber: { num: 3, base: 'uint32' },
    timeCreated: { num: 4, base: 'uint32' },
  },
}

export const RECORD: MessageSpec = {
  globalNum: 20,
  fields: {
    timestamp: { num: 253, base: 'uint32' },
    distance: { num: 5, base: 'uint32', scale: 100 },
    speed: { num: 6, base: 'uint16', scale: 1000 },
  },
}

export const LAP: MessageSpec = {
  globalNum: 19,
  fields: {
    messageIndex: { num: 254, base: 'uint16' },
    timestamp: { num: 253, base: 'uint32' },
    startTime: { num: 2, base: 'uint32' },
    totalElapsedTime: { num: 7, base: 'uint32', scale: 1000 },
    totalTimerTime: { num: 8, base: 'uint32', scale: 1000 },
    totalDistance: { num: 9, base: 'uint32', scale: 100 },
    avgSpeed: { num: 13, base: 'uint16', scale: 1000 },
    maxSpeed: { num: 14, base: 'uint16', scale: 1000 },
    event: { num: 0, base: 'enum' },
    eventType: { num: 1, base: 'enum' },
  },
}

export const SESSION: MessageSpec = {
  globalNum: 18,
  fields: {
    messageIndex: { num: 254, base: 'uint16' },
    timestamp: { num: 253, base: 'uint32' },
    startTime: { num: 2, base: 'uint32' },
    totalElapsedTime: { num: 7, base: 'uint32', scale: 1000 },
    totalTimerTime: { num: 8, base: 'uint32', scale: 1000 },
    totalDistance: { num: 9, base: 'uint32', scale: 100 },
    sport: { num: 5, base: 'enum' },
    subSport: { num: 6, base: 'enum' },
    firstLapIndex: { num: 25, base: 'uint16' },
    numLaps: { num: 26, base: 'uint16' },
    event: { num: 0, base: 'enum' },
    eventType: { num: 1, base: 'enum' },
  },
}

export const ACTIVITY: MessageSpec = {
  globalNum: 34,
  fields: {
    timestamp: { num: 253, base: 'uint32' },
    totalTimerTime: { num: 15, base: 'uint32', scale: 1000 },
    numSessions: { num: 1, base: 'uint16' },
    type: { num: 2, base: 'enum' },
    event: { num: 3, base: 'enum' },
    eventType: { num: 4, base: 'enum' },
  },
}

export type FitSport = 'running' | 'cycling'

export const SPORT_CODES: Readonly<Record<FitSport, number>> = { running: 1, cycling: 2 }
export const SUB_SPORT_TRACK = 4
export const SUB_SPORT_CODES: Readonly<Record<number, string>> = { 0: 'generic', 4: 'track' }

export const FILE_TYPE_ACTIVITY = 4
export const EVENT_LAP = 9
export const EVENT_SESSION = 8
export const EVENT_ACTIVITY = 26
export const EVENT_TYPE_STOP = 1

export function toFitTimestamp(epochMs: number): number {
  return Math.round((epochMs - FIT_EPOCH_MS) / 1000)
}

export function fromFitTimestamp(seconds: number): number {
  return FIT_EPOCH_MS + seconds * 1000
}

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01,
  0x8801, 0x4400,
]

/** The CRC-16 defined by the FIT protocol, over an arbitrary run of bytes. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0

  for (const byte of bytes) {
    crc = nibble(crc, byte & 0x0f)
    crc = nibble(crc, (byte >> 4) & 0x0f)
  }

  return crc
}

function nibble(crc: number, value: number): number {
  const carry = CRC_TABLE[crc & 0x0f]!
  return ((crc >> 4) & 0x0fff) ^ carry ^ CRC_TABLE[value]!
}

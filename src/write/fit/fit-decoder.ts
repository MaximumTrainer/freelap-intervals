import type { FieldSpec, MessageSpec } from './fit-format'
import {
  LAP,
  RECORD,
  SESSION,
  SPORT_CODES,
  SUB_SPORT_CODES,
  baseTypeById,
  crc16,
  fromFitTimestamp,
} from './fit-format'

export interface DecodedRecord {
  readonly timestampEpochMs: number
  readonly distanceM: number | null
  readonly speedMps: number | null
}

export interface DecodedLap {
  readonly startEpochMs: number
  readonly totalElapsedS: number | null
  readonly distanceM: number | null
  readonly avgSpeedMps: number | null
  readonly maxSpeedMps: number | null
}

export interface DecodedSession {
  readonly sport: string
  readonly subSport: string
  readonly startEpochMs: number
  readonly totalElapsedS: number | null
  readonly totalDistanceM: number | null
  readonly numLaps: number | null
}

export interface DecodedFitActivity {
  readonly records: readonly DecodedRecord[]
  readonly laps: readonly DecodedLap[]
  readonly session: DecodedSession
}

interface FieldLayout {
  readonly num: number
  readonly size: number
  readonly baseTypeId: number
}

interface Definition {
  readonly globalNum: number
  readonly fields: readonly FieldLayout[]
}

type RawMessage = ReadonlyMap<number, number | null>

const HEADER_SIZE_OFFSET = 0
const SIGNATURE = '.FIT'
const DEFINITION_BIT = 0x40
const COMPRESSED_BIT = 0x80
const LOCAL_TYPE_MASK = 0x0f
const SPORT_NAMES = new Map(Object.entries(SPORT_CODES).map(([name, code]) => [code, name]))

/** Reads back a FIT file — used to prove what was uploaded actually decodes as intended. */
export function decodeFitActivity(bytes: Uint8Array): DecodedFitActivity {
  const messages = readMessages(bytes)

  return {
    records: messages.filter(matching(RECORD)).map(toRecord),
    laps: messages.filter(matching(LAP)).map(toLap),
    session: toSession(messages.find(matching(SESSION))?.values),
  }
}

function matching(spec: MessageSpec): (message: { globalNum: number }) => boolean {
  return (message) => message.globalNum === spec.globalNum
}

function readMessages(bytes: Uint8Array): Array<{ globalNum: number; values: RawMessage }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerSize = bytes[HEADER_SIZE_OFFSET] ?? 0

  verifyIntegrity(bytes, view, headerSize)

  const dataEnd = headerSize + view.getUint32(4, true)
  const definitions = new Map<number, Definition>()
  const messages: Array<{ globalNum: number; values: RawMessage }> = []
  let position = headerSize

  while (position < dataEnd) {
    const header = bytes[position]!
    position += 1

    if ((header & COMPRESSED_BIT) !== 0) throw new Error('Compressed timestamp headers are not supported')

    const localType = header & LOCAL_TYPE_MASK

    if ((header & DEFINITION_BIT) !== 0) {
      const [definition, next] = readDefinition(bytes, view, position)
      definitions.set(localType, definition)
      position = next
      continue
    }

    const definition = definitions.get(localType)
    if (!definition) throw new Error(`Data message ${localType} arrived before its definition`)

    const [values, next] = readValues(view, position, definition)
    messages.push({ globalNum: definition.globalNum, values })
    position = next
  }

  return messages
}

function verifyIntegrity(bytes: Uint8Array, view: DataView, headerSize: number): void {
  const signature = String.fromCharCode(...bytes.subarray(8, 12))
  if (signature !== SIGNATURE) throw new Error('Not a FIT file: missing .FIT signature')

  const expected = view.getUint16(bytes.length - 2, true)
  const actual = crc16(bytes.subarray(0, bytes.length - 2))
  if (expected !== actual) throw new Error(`FIT file CRC mismatch: expected ${expected}, computed ${actual}`)

  if (headerSize + view.getUint32(4, true) + 2 !== bytes.length) {
    throw new Error('FIT data size does not match the file length')
  }
}

function readDefinition(bytes: Uint8Array, view: DataView, start: number): [Definition, number] {
  const architecture = bytes[start + 1]
  if (architecture !== 0) throw new Error('Big-endian FIT files are not supported')

  const globalNum = view.getUint16(start + 2, true)
  const fieldCount = bytes[start + 4]!
  const fields: FieldLayout[] = []
  let position = start + 5

  for (let field = 0; field < fieldCount; field += 1) {
    fields.push({ num: bytes[position]!, size: bytes[position + 1]!, baseTypeId: bytes[position + 2]! })
    position += 3
  }

  return [{ globalNum, fields }, position]
}

function readValues(view: DataView, start: number, definition: Definition): [RawMessage, number] {
  const values = new Map<number, number | null>()
  let position = start

  for (const field of definition.fields) {
    values.set(field.num, readValue(view, position, field))
    position += field.size
  }

  return [values, position]
}

function readValue(view: DataView, position: number, field: FieldLayout): number | null {
  const base = baseTypeById(field.baseTypeId)
  if (base?.size !== field.size) return null

  const raw = base.size === 1 ? view.getUint8(position) : base.size === 2 ? view.getUint16(position, true) : view.getUint32(position, true)

  return raw === base.invalid ? null : raw
}

function scaled(values: RawMessage, field: FieldSpec): number | null {
  const raw = values.get(field.num)
  return raw === null || raw === undefined ? null : raw / (field.scale ?? 1)
}

function required(values: RawMessage, field: FieldSpec, name: string): number {
  const value = scaled(values, field)
  if (value === null) throw new Error(`FIT message is missing ${name}`)
  return value
}

function toRecord({ values }: { values: RawMessage }): DecodedRecord {
  return {
    timestampEpochMs: fromFitTimestamp(required(values, RECORD.fields.timestamp!, 'a record timestamp')),
    distanceM: scaled(values, RECORD.fields.distance!),
    speedMps: scaled(values, RECORD.fields.speed!),
  }
}

function toLap({ values }: { values: RawMessage }): DecodedLap {
  return {
    startEpochMs: fromFitTimestamp(required(values, LAP.fields.startTime!, 'a lap start time')),
    totalElapsedS: scaled(values, LAP.fields.totalElapsedTime!),
    distanceM: scaled(values, LAP.fields.totalDistance!),
    avgSpeedMps: scaled(values, LAP.fields.avgSpeed!),
    maxSpeedMps: scaled(values, LAP.fields.maxSpeed!),
  }
}

function toSession(values: RawMessage | undefined): DecodedSession {
  if (!values) throw new Error('The FIT file carries no session message')

  return {
    sport: SPORT_NAMES.get(scaled(values, SESSION.fields.sport!) ?? -1) ?? 'unknown',
    subSport: SUB_SPORT_CODES[scaled(values, SESSION.fields.subSport!) ?? -1] ?? 'unknown',
    startEpochMs: fromFitTimestamp(required(values, SESSION.fields.startTime!, 'a session start time')),
    totalElapsedS: scaled(values, SESSION.fields.totalElapsedTime!),
    totalDistanceM: scaled(values, SESSION.fields.totalDistance!),
    numLaps: scaled(values, SESSION.fields.numLaps!),
  }
}

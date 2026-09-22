import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { Session } from "@opencode/schema/session"

export type ShellInfo = {
  id: string
  command: string
  file: string
}

export type Spike = {
  sessionID: Session.ID
  shellID: string
  command: string
  text: string
  cursor: number
}

type Observation = {
  info: ShellInfo
  sessionID: Session.ID
  command: string
  offset: number
  seen: number
  changedAt: number | null
  pending?: Spike
}

export class ProgressRelay {
  private readonly shells = new Map<string, ShellInfo>()
  private readonly sessions = new Map<string, { sessionID: Session.ID; command: string }>()
  private readonly active = new Map<string, Observation>()
  private readonly terminal = new Set<string>()

  constructor(
    private readonly quietMs = 1_000,
    private readonly maxBytes = 16 * 1_024,
  ) {}

  created(info: ShellInfo) {
    if (this.terminal.has(info.id)) return
    this.shells.set(info.id, info)
    this.activate(info.id)
  }

  background(shellID: string, sessionID: Session.ID, command: string) {
    if (this.terminal.has(shellID)) return
    this.sessions.set(shellID, { sessionID, command })
    this.activate(shellID)
  }

  exited(shellID: string) {
    if (this.shells.has(shellID) || this.sessions.has(shellID) || this.active.has(shellID)) {
      this.terminal.add(shellID)
      if (this.terminal.size > 1_024) this.terminal.delete(this.terminal.values().next().value!)
    }
    this.shells.delete(shellID)
    this.sessions.delete(shellID)
    this.active.delete(shellID)
  }

  tick(now = performance.now()) {
    return [...this.active.values()].flatMap((observation) => {
      if (observation.pending) return []
      const size = fileSize(observation.info.file)
      if (size === undefined) return []
      if (size < observation.offset) {
        observation.offset = 0
        observation.seen = 0
        observation.changedAt = null
      }
      if (size > observation.seen) {
        observation.seen = size
        observation.changedAt = now
        return []
      }
      if (
        size <= observation.offset ||
        observation.changedAt === null ||
        now - observation.changedAt < this.quietMs
      )
        return []

      const unread = size - observation.offset
      const omitted = Math.max(0, unread - this.maxBytes)
      const start = observation.offset + omitted
      const bytes = readRange(observation.info.file, start, size)
      if (!bytes) return []
      const leading = omitted > 0 ? leadingContinuationBytes(bytes) : 0
      const complete = completeUtf8Bytes(bytes.subarray(leading))
      const decoded = complete.bytes.toString("utf8").trimEnd()
      if (decoded.trim().length === 0) return []
      const skipped = omitted + leading
      const spike = {
        sessionID: observation.sessionID,
        shellID: observation.info.id,
        command: observation.command,
        text: skipped > 0 ? `[perk: ${skipped} earlier bytes omitted]\n${decoded}` : decoded,
        cursor: start + leading + complete.length,
      }
      observation.pending = spike
      return [spike]
    })
  }

  deliverable(spike: Spike) {
    return this.active.get(spike.shellID)?.pending === spike
  }

  acknowledge(spike: Spike) {
    const observation = this.active.get(spike.shellID)
    if (observation?.pending !== spike) return
    observation.offset = spike.cursor
    observation.changedAt = null
    delete observation.pending
  }

  retry(spike: Spike) {
    const observation = this.active.get(spike.shellID)
    if (observation?.pending === spike) delete observation.pending
  }

  private activate(shellID: string) {
    if (this.active.has(shellID)) return
    const info = this.shells.get(shellID)
    const session = this.sessions.get(shellID)
    if (!info || !session) return
    this.active.set(shellID, {
      info,
      ...session,
      offset: 0,
      seen: 0,
      changedAt: null,
    })
  }
}

function fileSize(path: string) {
  try {
    const fd = openSync(path, "r")
    try {
      return fstatSync(fd).size
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function readRange(path: string, start: number, end: number) {
  try {
    const buffer = Buffer.allocUnsafe(end - start)
    const fd = openSync(path, "r")
    try {
      const read = readSync(fd, buffer, 0, buffer.length, start)
      return buffer.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function leadingContinuationBytes(bytes: Buffer) {
  let index = 0
  while (index < bytes.length && (bytes[index]! & 0xc0) === 0x80) index += 1
  return index
}

function completeUtf8Bytes(bytes: Buffer) {
  if (bytes.length === 0) return { bytes, length: 0 }
  let lead = bytes.length - 1
  while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80) lead -= 1
  if (lead < 0) return { bytes: Buffer.alloc(0), length: 0 }
  const first = bytes[lead]!
  const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 1
  const length = bytes.length - lead < expected ? lead : bytes.length
  return { bytes: bytes.subarray(0, length), length }
}

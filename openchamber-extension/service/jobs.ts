import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import { parseLaunch, type NormalizedLaunch, type VisibleJob } from "../../src/protocol.js"
export type { VisibleJob } from "../../src/protocol.js"

const JOB_ID = /^[0-9a-f]{8}$/
const MAX_METADATA_BYTES = 64 * 1024

function readLaunch(path: string, expectedId: string): NormalizedLaunch | null {
  try {
    if (statSync(path).size > MAX_METADATA_BYTES) return null
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return parseLaunch(value, expectedId)
  } catch {
    return null
  }
}

function readOutcome(path: string): { outcome: string; finishedAt: string } | null {
  try {
    const stat = statSync(path)
    const outcome = stat.size > 128 ? "?" : readFileSync(path, "utf8").trim() || "?"
    return { outcome, finishedAt: stat.mtime.toISOString() }
  } catch {
    return null
  }
}

function validJobDirectory(spoolDir: string, id: string): string | null {
  if (!JOB_ID.test(id)) return null
  const dir = join(spoolDir, id)
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null
  } catch {
    return null
  }
}

export function listJobs(spoolDir: string, sessionId: string): VisibleJob[] {
  let entries
  try {
    entries = readdirSync(spoolDir, { withFileTypes: true })
  } catch {
    return []
  }

  const jobs: VisibleJob[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue
    const dir = join(spoolDir, entry.name)
    const launch = readLaunch(join(dir, "launch.json"), entry.name)
    if (!launch || launch.sessionId !== sessionId) continue
    const result = readOutcome(join(dir, "exit"))
    jobs.push({
      ...launch,
      jobDir: dir,
      cancellationRequested: existsSync(join(dir, "cancel")),
      state: result === null ? "running" : "completed",
      ...(result === null ? {} : result),
    })
  }

  return jobs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

export type CancellationResult =
  | { state: "requested" }
  | { state: "completed" }
  | { state: "not-found" }

export function requestCancellation(
  spoolDir: string,
  id: string,
  sessionId: string,
): CancellationResult {
  const dir = validJobDirectory(spoolDir, id)
  if (!dir) return { state: "not-found" }
  const launch = readLaunch(join(dir, "launch.json"), id)
  if (!launch || launch.sessionId !== sessionId) return { state: "not-found" }
  if (readOutcome(join(dir, "exit"))) return { state: "completed" }

  const path = join(dir, "cancel")
  try {
    closeSync(openSync(path, "wx", 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  return { state: "requested" }
}

export type OutputStream = "stdout" | "stderr" | "progress"

export type OutputChunk = {
  identity: string | null
  offset: number
  nextOffset: number
  size: number
  data: string
  complete: boolean
  reset: boolean
}

const STREAM_FILE: Record<OutputStream, string> = {
  stdout: "out",
  stderr: "err",
  progress: "drip",
}

export function readJobOutput(
  spoolDir: string,
  id: string,
  sessionId: string,
  stream: OutputStream,
  requestedOffset: number,
  maxBytes = 64 * 1024,
): OutputChunk | null {
  const dir = validJobDirectory(spoolDir, id)
  if (!dir) return null
  const launch = readLaunch(join(dir, "launch.json"), id)
  if (!launch || launch.sessionId !== sessionId) return null

  const path = join(dir, STREAM_FILE[stream])
  let size = 0
  let identity: string | null = null
  try {
    const stat = statSync(path)
    size = stat.size
    identity = `${stat.dev}:${stat.ino}`
  } catch {
    // stdout and stderr may not exist during the brief spawn publication window.
  }

  const reset = requestedOffset > size
  const offset = reset ? 0 : requestedOffset
  const length = Math.min(Math.max(0, maxBytes), size - offset)
  const buffer = Buffer.alloc(length)
  let read = 0
  let fd: number | undefined
  try {
    if (length > 0) {
      fd = openSync(path, "r")
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, offset + read)
        if (count === 0) break
        read += count
      }
    }
  } catch {
    // A concurrent completion sweep or replacement is retried on the next poll.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Closing a read-only sidecar must not crash the extension service.
      }
    }
  }

  const nextOffset = offset + read
  return {
    identity,
    offset,
    nextOffset,
    size,
    data: buffer.subarray(0, read).toString("base64"),
    complete: readOutcome(join(dir, "exit")) !== null && nextOffset >= size,
    reset,
  }
}

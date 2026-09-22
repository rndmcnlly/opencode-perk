// Shared, dependency-free contract for the plugin and its observers.
export const DEFAULT_TIMEOUT_MS = 3_600_000
export const DEFAULT_COALESCE_MS = 1_000
export const MIN_COALESCE_MS = 300

export type LaunchRecord = {
  schema: 2
  id: string
  sessionId: string
  label?: string
  command: string
  cwd: string
  pgid: number
  startedAt: string
  timeoutMs: number
  expectedMs?: number
}

export type NormalizedLaunch = Omit<LaunchRecord, "schema" | "timeoutMs"> & {
  timeoutMs?: number
}

export type VisibleJob = NormalizedLaunch & {
  jobDir: string
  finishedAt?: string
  cancellationRequested: boolean
  state: "running" | "completed"
  outcome?: string
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

// Version 1 had seconds-based estimates and no deadline. A transitional writer
// also used version 1 with millisecond fields, so accept those explicit fields.
export function parseLaunch(value: unknown, expectedId: string): NormalizedLaunch | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (
    (v.schema !== 1 && v.schema !== 2) ||
    v.id !== expectedId ||
    typeof v.sessionId !== "string" ||
    (v.label !== undefined && typeof v.label !== "string") ||
    typeof v.command !== "string" ||
    typeof v.cwd !== "string" ||
    !positiveInteger(v.pgid) ||
    typeof v.startedAt !== "string" ||
    !Number.isFinite(Date.parse(v.startedAt)) ||
    (v.schema === 2 && !positiveInteger(v.timeoutMs)) ||
    (v.timeoutMs !== undefined && !positiveInteger(v.timeoutMs)) ||
    (v.expectedMs !== undefined && !positiveInteger(v.expectedMs))
  ) return null

  let expectedMs = v.expectedMs as number | undefined
  if (v.schema === 1 && expectedMs === undefined && v.expectedSeconds !== undefined) {
    if (typeof v.expectedSeconds !== "number" || !Number.isFinite(v.expectedSeconds) ||
      v.expectedSeconds <= 0) return null
    expectedMs = Math.max(1, Math.round(v.expectedSeconds * 1000))
    if (!positiveInteger(expectedMs)) return null
  }
  return {
    id: expectedId,
    sessionId: v.sessionId,
    ...(v.label === undefined ? {} : { label: v.label as string }),
    command: v.command,
    cwd: v.cwd,
    pgid: v.pgid,
    startedAt: v.startedAt,
    ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs as number }),
    ...(expectedMs === undefined ? {} : { expectedMs }),
  }
}

export function describeOutcome(code: string, timeoutMs?: number): string {
  if (code === "timeout") {
    return timeoutMs === undefined ? "timed out" : `timed out after ${timeoutMs} ms`
  }
  if (code === "shutdown") return "stopped on shutdown"
  if (code.startsWith("cancelled:")) return `cancelled by ${code.slice(10) || "signal"}`
  return `exited ${code}`
}

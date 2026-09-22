import type { HostClient } from "@openchamber/sdk"
import type { VisibleJob } from "../../src/protocol.js"

export type PanelHost = Pick<HostClient, "onReady" | "onSession" | "serviceRequest"> & {
  storage: Pick<HostClient["storage"], "get" | "set">
}

const sessionId = "visual-preview"
const previewStartedAt = Date.now()
const storage = new Map<string, unknown>([[`collapsed:${sessionId}`, ["deadbeef"]]])
let cancellationRequestedAt: number | null = null

function iso(time: number): string {
  return new Date(time).toISOString()
}

function activeJob(now: number): VisibleJob {
  const naturalFinish = previewStartedAt + 22_000
  const cancelledFinish = cancellationRequestedAt === null ? Infinity : cancellationRequestedAt + 800
  const finishedAt = Math.min(naturalFinish, cancelledFinish)
  const completed = now >= finishedAt
  return {
    id: "a1b2c3d4",
    sessionId,
    label: "Verify richer card headers and responsive output behavior",
    command:
      "npm run check -- --reporter=spec --fixture=" +
      "a-very-long-unbroken-argument-".repeat(18),
    cwd: "/Users/adam/Desktop/opencode-perk",
    pgid: 42117,
    startedAt: iso(previewStartedAt - 8_000),
    timeoutMs: 120_000,
    expectedMs: 30_000,
    jobDir: "/tmp/opencode/perk/a1b2c3d4",
    ...(completed ? { finishedAt: iso(finishedAt) } : {}),
    cancellationRequested: cancellationRequestedAt !== null && !completed,
    state: completed ? "completed" : "running",
    ...(completed
      ? { outcome: cancellationRequestedAt === null ? "0" : "cancelled:SIGTERM" }
      : {}),
  }
}

function jobs(now = Date.now()): VisibleJob[] {
  return [
    activeJob(now),
    {
      id: "cafefeed",
      sessionId,
      command:
        "uv run --script analyze.py --input recordings/session-with-a-long-file-name.wav --emit-json",
      cwd: "/Users/adam/Desktop/research",
      pgid: 42142,
      startedAt: iso(previewStartedAt - 67_000),
      timeoutMs: 3_600_000,
      jobDir: "/tmp/opencode/perk/cafefeed",
      cancellationRequested: false,
      state: "running",
    },
    {
      id: "deadbeef",
      sessionId,
      label: "Build extension bundles",
      command: "npm run build:extension",
      cwd: "/Users/adam/Desktop/opencode-perk",
      pgid: 41902,
      startedAt: iso(previewStartedAt - 125_000),
      finishedAt: iso(previewStartedAt - 65_000),
      timeoutMs: 120_000,
      expectedMs: 60_000,
      jobDir: "/tmp/opencode/perk/deadbeef",
      cancellationRequested: false,
      state: "completed",
      outcome: "0",
    },
    {
      id: "badc0ffe",
      sessionId,
      label:
        "A deliberately long task summary that demonstrates wrapping behavior without forcing the entire card wider than the preview viewport",
      command: "node scripts/check-layout.js",
      cwd: "/Users/adam/Desktop/opencode-perk",
      pgid: 41881,
      startedAt: iso(previewStartedAt - 94_200),
      finishedAt: iso(previewStartedAt - 90_000),
      timeoutMs: 30_000,
      jobDir: "/tmp/opencode/perk/badc0ffe",
      cancellationRequested: false,
      state: "completed",
      outcome: "1",
    },
  ]
}

function output(job: VisibleJob, stream: string, now: number): string {
  if (stream === "stderr") {
    return job.id === "badc0ffe" ? "AssertionError: card exceeded viewport width\n" : ""
  }
  if (stream === "progress") {
    if (job.state === "completed") return "complete\n"
    const elapsed = now - Date.parse(job.startedAt)
    return `processed ${Math.max(1, Math.floor(elapsed / 2_000))} batches\n`
  }
  if (job.id === "a1b2c3d4") {
    const lines = Math.min(15, Math.max(1, Math.floor((now - previewStartedAt + 8_000) / 2_000)))
    return [
      "building extension preview...",
      `LONG_LINE=${"0123456789abcdef".repeat(40)}`,
      ...Array.from({ length: lines }, (_, index) => `check ${index + 1}: passed`),
      ...(job.state === "completed" ? ["all checks complete"] : []),
    ].join("\n") + "\n"
  }
  if (job.id === "cafefeed") {
    const lines = Math.min(40, Math.max(2, Math.floor((now - previewStartedAt + 67_000) / 3_000)))
    return Array.from(
      { length: lines },
      (_, index) => `frame ${String(index + 1).padStart(3, "0")}: rms=-18.${index % 10}dB`,
    ).join("\n") + "\n"
  }
  if (job.id === "deadbeef") return "panel/main.js  64.3kb\nservice/main.js  7.8kb\n"
  return "layout assertion failed\n"
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function createMockHost(): PanelHost {
  return {
    onReady: () => () => {},
    onSession: (listener) => {
      queueMicrotask(() =>
        listener({ id: sessionId, title: "Visual preview", busy: true }),
      )
      return () => {}
    },
    storage: {
      get: async (key) => storage.get(key) as never,
      set: async (key, value) => {
        storage.set(key, value)
      },
    },
    serviceRequest: async (request) => {
      const now = Date.now()
      if (request.method === "GET" && request.path === "/jobs") {
        return { status: 200, body: JSON.stringify({ jobs: jobs(now) }) }
      }
      const outputMatch = request.path.match(
        /^\/jobs\/([0-9a-f]{8})\/output\/(stdout|stderr|progress)$/,
      )
      if (request.method === "GET" && outputMatch) {
        const job = jobs(now).find((candidate) => candidate.id === outputMatch[1])
        if (!job) return { status: 404, body: JSON.stringify({ error: "not-found" }) }
        const bytes = new TextEncoder().encode(output(job, outputMatch[2], now))
        const offset = Number(request.query?.offset ?? "0")
        return {
          status: 200,
          body: JSON.stringify({
            identity: `mock-${job.id}`,
            offset,
            nextOffset: bytes.length,
            size: bytes.length,
            data: base64(bytes.slice(offset)),
            complete: job.state === "completed",
            reset: false,
          }),
        }
      }
      if (request.method === "POST" && request.path === "/jobs/a1b2c3d4/cancel") {
        cancellationRequestedAt ??= now
        return { status: 202, body: JSON.stringify({ state: "requested" }) }
      }
      return { status: 404, body: JSON.stringify({ error: "not-found" }) }
    },
  }
}

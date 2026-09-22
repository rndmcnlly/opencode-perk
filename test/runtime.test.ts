import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { test } from "node:test"
import { listJobs, requestCancellation } from "../openchamber-extension/service/jobs.js"
import { PerkRuntime } from "../src/runtime.js"
import { SPOOL_DIR, type LaunchRecord } from "../src/spool.js"
import { killJob } from "../src/job.js"

async function waitFor(path: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("launch publishes metadata for external observers", async () => {
  const runtime = new PerkRuntime()
  runtime.start()
  let dir: string | undefined
  try {
    const job = await runtime.launch({
      command: "sleep 30",
      cwd: process.cwd(),
      sessionID: "session-observer",
      inject: async () => {},
      coalesceMs: 1_000,
      label: "Check external observation",
      expectedMs: 30_000,
      timeoutMs: 60_000,
    })
    dir = job.dir
    const metadata = JSON.parse(
      readFileSync(`${job.dir}/launch.json`, "utf8"),
    ) as LaunchRecord

    assert.equal(metadata.schema, 2)
    assert.equal(metadata.id, job.id)
    assert.equal(metadata.sessionId, "session-observer")
    assert.equal(metadata.label, "Check external observation")
    assert.equal(metadata.command, "sleep 30")
    assert.equal(metadata.cwd, process.cwd())
    assert.equal(metadata.pgid, job.pgid)
    assert.equal(metadata.expectedMs, 30_000)
    assert.equal(metadata.timeoutMs, 60_000)
    assert.ok(Number.isFinite(Date.parse(metadata.startedAt)))
  } finally {
    await runtime.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test("a service cancellation request stops the owned process group", async () => {
  const runtime = new PerkRuntime()
  runtime.start()
  let dir: string | undefined
  try {
    const job = await runtime.launch({
      command: "sleep 30",
      cwd: process.cwd(),
      sessionID: "session-cancel",
      inject: async () => {},
    })
    dir = job.dir

    assert.deepEqual(requestCancellation(SPOOL_DIR, job.id, "session-cancel"), {
      state: "requested",
    })
    await waitFor(`${job.dir}/exit`)
    assert.equal(readFileSync(`${job.dir}/exit`, "utf8"), "cancelled:TERM\n")
  } finally {
    await runtime.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test("a job is terminated after its timeout", async () => {
  const runtime = new PerkRuntime()
  runtime.start()
  let dir: string | undefined
  const messages: string[] = []
  try {
    const job = await runtime.launch({
      command: "sleep 30",
      cwd: process.cwd(),
      sessionID: "session-timeout",
      inject: async (_sessionID, message) => {
        messages.push(message)
      },
      timeoutMs: 100,
    })
    dir = job.dir

    await waitFor(`${job.dir}/exit`)
    runtime.monitor.tick()
    await runtime.monitor.settled()
    assert.equal(readFileSync(`${job.dir}/exit`, "utf8"), "timeout\n")
    const visible = listJobs(SPOOL_DIR, "session-timeout").find((visible) => visible.id === job.id)!
    assert.equal(visible.outcome, "timeout")
    assert.equal(visible.timeoutMs, 100)
    assert.equal(visible.state, "completed")
    assert.deepEqual(messages, [
      `Job ${job.id} timed out after 100 ms: out 0 bytes, err 0 bytes`,
    ])
  } finally {
    await runtime.dispose()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

test("dispose waits for a TERM-resistant process group and publishes shutdown", async () => {
  const runtime = new PerkRuntime()
  const job = await runtime.launch({
    command: `sh -c 'trap "" TERM; echo ready >> "$PERK_DRIP"; while :; do sleep 1; done'`,
    cwd: process.cwd(), sessionID: "session-shutdown", inject: async () => {},
  })
  try {
    const deadline = performance.now() + 3000
    while (!readFileSync(`${job.dir}/drip`, "utf8").includes("ready")) {
      if (performance.now() >= deadline) throw new Error("Job failed to start")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await runtime.dispose()
    assert.equal(runtime.monitor.listeners.size, 0)
    assert.equal(readFileSync(`${job.dir}/exit`, "utf8"), "shutdown\n")
    assert.throws(() => process.kill(-job.pgid, 0), { code: "ESRCH" })
  } finally {
    killJob(job.pgid, "SIGKILL")
    await runtime.dispose()
    rmSync(job.dir, { recursive: true, force: true })
  }
})

test("dispose includes a launch still awaiting its spawn event", async () => {
  const runtime = new PerkRuntime()
  const sessionID = `launch-race-${crypto.randomUUID()}`
  const pending = runtime.launch({
    command: "sleep 30", cwd: process.cwd(), sessionID, inject: async () => {},
  })
  const rejected = assert.rejects(pending, /disposed while launching/)
  await runtime.dispose()
  await rejected
  const jobs = listJobs(SPOOL_DIR, sessionID)
  try {
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].outcome, "shutdown")
    assert.throws(() => process.kill(-jobs[0].pgid, 0), { code: "ESRCH" })
  } finally {
    for (const job of jobs) rmSync(job.jobDir, { recursive: true, force: true })
  }
})

test("wall-clock jumps do not trigger a monotonic deadline", async (t) => {
  const runtime = new PerkRuntime()
  const job = await runtime.launch({
    command: "sleep 30", cwd: process.cwd(), sessionID: "clock-jump",
    inject: async () => {}, timeoutMs: 10_000,
  })
  try {
    t.mock.method(Date, "now", () => 9_000_000_000_000)
    runtime.monitor.tick()
    t.mock.method(Date, "now", () => 0)
    runtime.monitor.tick()
    await runtime.dispose()
    assert.equal(readFileSync(`${job.dir}/exit`, "utf8"), "shutdown\n")
  } finally {
    await runtime.dispose()
    rmSync(job.dir, { recursive: true, force: true })
  }
})

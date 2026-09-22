import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  listJobs,
  readJobOutput,
  requestCancellation,
} from "../openchamber-extension/service/jobs.js"
import { makeJobFiles, writeLaunchRecord } from "../src/spool.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporarySpool() {
  const root = mkdtempSync(join(tmpdir(), "perk-openchamber-test-"))
  roots.push(root)
  return join(root, "spool")
}

function addJob(
  spool: string,
  sessionId: string,
  startedAt: string,
  outcome?: string,
) {
  const files = makeJobFiles(spool)
  writeLaunchRecord(files.launch, {
    schema: 2,
    id: files.id,
    sessionId,
    command: `sleep ${files.id}`,
    cwd: `/tmp/${sessionId}`,
    pgid: 123,
    startedAt,
    timeoutMs: 3_600_000,
  })
  if (outcome !== undefined) writeFileSync(files.exit, `${outcome}\n`)
  return files
}

test("lists only jobs belonging to the requested session", () => {
  const spool = temporarySpool()
  const older = addJob(spool, "session-1", "2026-09-17T12:00:00.000Z", "0")
  const newer = addJob(spool, "session-1", "2026-09-17T12:01:00.000Z")
  addJob(spool, "session-2", "2026-09-17T12:02:00.000Z")

  const jobs = listJobs(spool, "session-1")
  assert.deepEqual(jobs[0], {
    id: older.id,
    sessionId: "session-1",
    command: `sleep ${older.id}`,
    cwd: "/tmp/session-1",
    jobDir: older.dir,
    pgid: 123,
    startedAt: "2026-09-17T12:00:00.000Z",
    timeoutMs: 3_600_000,
    finishedAt: jobs[0].finishedAt,
    cancellationRequested: false,
    state: "completed",
    outcome: "0",
  })
  assert.ok(Number.isFinite(Date.parse(jobs[0].finishedAt!)))
  assert.deepEqual(
    jobs[1],
    {
      id: newer.id,
      sessionId: "session-1",
      command: `sleep ${newer.id}`,
      cwd: "/tmp/session-1",
      jobDir: newer.dir,
      pgid: 123,
      startedAt: "2026-09-17T12:01:00.000Z",
      timeoutMs: 3_600_000,
      cancellationRequested: false,
      state: "running",
    },
  )
})

test("missing and malformed spool entries are ignored", () => {
  const spool = temporarySpool()
  assert.deepEqual(listJobs(spool, "session-1"), [])

  mkdirSync(spool, { recursive: true })
  const malformed = join(spool, "11111111")
  mkdirSync(malformed)
  writeFileSync(join(malformed, "launch.json"), "not json")
  mkdirSync(join(spool, "not-a-job"))

  assert.deepEqual(listJobs(spool, "session-1"), [])
})

test("preserves timeout as a distinct visible outcome", () => {
  const spool = temporarySpool()
  const timedOut = addJob(
    spool,
    "session-1",
    "2026-09-17T12:00:00.000Z",
    "timeout",
  )

  const jobs = listJobs(spool, "session-1")
  assert.equal(jobs[0].id, timedOut.id)
  assert.equal(jobs[0].outcome, "timeout")
})

test("legacy jobs remain visible, readable, and cancellable without a fabricated timeout", () => {
  const spool = temporarySpool()
  const files = makeJobFiles(spool)
  writeFileSync(files.launch, JSON.stringify({
    schema: 1, id: files.id, sessionId: "legacy-session", command: "sleep 20",
    cwd: "/tmp", pgid: 123, startedAt: "2026-09-17T12:00:00.000Z",
    expectedSeconds: 0.25,
  }))
  writeFileSync(files.out, "legacy output")
  const [job] = listJobs(spool, "legacy-session")
  assert.equal(job.expectedMs, 250)
  assert.equal(job.timeoutMs, undefined)
  const chunk = readJobOutput(spool, files.id, "legacy-session", "stdout", 0)!
  assert.equal(Buffer.from(chunk.data, "base64").toString(), "legacy output")
  assert.deepEqual(requestCancellation(spool, files.id, "legacy-session"), { state: "requested" })
})

test("cancellation is session-scoped, idempotent, and refuses completed jobs", () => {
  const spool = temporarySpool()
  const running = addJob(spool, "session-1", "2026-09-17T12:00:00.000Z")
  const completed = addJob(
    spool,
    "session-1",
    "2026-09-17T12:01:00.000Z",
    "0",
  )

  assert.deepEqual(requestCancellation(spool, running.id, "session-2"), {
    state: "not-found",
  })
  assert.equal(existsSync(running.cancel), false)
  assert.deepEqual(requestCancellation(spool, running.id, "session-1"), {
    state: "requested",
  })
  assert.equal(existsSync(running.cancel), true)
  assert.deepEqual(requestCancellation(spool, running.id, "session-1"), {
    state: "requested",
  })
  assert.deepEqual(requestCancellation(spool, completed.id, "session-1"), {
    state: "completed",
  })
  assert.equal(existsSync(completed.cancel), false)
})

test("reads bounded output chunks without exposing another session", () => {
  const spool = temporarySpool()
  const job = addJob(spool, "session-1", "2026-09-17T12:00:00.000Z")
  writeFileSync(job.out, "alpha\nbeta\n")

  assert.equal(readJobOutput(spool, job.id, "session-2", "stdout", 0), null)
  const first = readJobOutput(spool, job.id, "session-1", "stdout", 0, 6)!
  assert.equal(Buffer.from(first.data, "base64").toString(), "alpha\n")
  assert.equal(first.offset, 0)
  assert.equal(first.nextOffset, 6)
  assert.equal(first.size, 11)
  assert.equal(first.complete, false)

  const second = readJobOutput(
    spool,
    job.id,
    "session-1",
    "stdout",
    first.nextOffset,
    6,
  )!
  assert.equal(Buffer.from(second.data, "base64").toString(), "beta\n")
  assert.equal(second.nextOffset, 11)
})

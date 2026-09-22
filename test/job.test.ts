import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { killJob, ManagedJob, spawnBackground, TERMINATION_GRACE_MS } from "../src/job.js"
import { makeJobFiles } from "../src/spool.js"

const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  for (const pgid of groups.splice(0)) killJob(pgid, "SIGKILL")
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture(command: string) {
  const root = mkdtempSync(join(tmpdir(), "perk-job-test-"))
  roots.push(root)
  const files = makeJobFiles(join(root, "spool"))
  const pgid = await spawnBackground(command, files, root)
  groups.push(pgid)
  return { files, job: new ManagedJob(pgid, files), pgid }
}

async function until(predicate: () => boolean, timeout = 4000) {
  const deadline = performance.now() + timeout
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for job")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function finish(job: ManagedJob) {
  await until(() => {
    job.observe(performance.now())
    return job.finished
  })
}

test("wrapper captures streams and drip; supervisor publishes the terminal gate", async () => {
  const { files, job } = await fixture([
    "echo hello", "echo bad >&2", 'echo progress >> "$PERK_DRIP"',
    "exit 17 # trailing comment",
  ].join("\n"))
  await until(() => existsSync(files.result))
  assert.equal(existsSync(files.exit), false)
  await finish(job)
  assert.equal(readFileSync(files.exit, "utf8"), "17\n")
  assert.equal(readFileSync(files.out, "utf8"), "hello\n")
  assert.equal(readFileSync(files.err, "utf8"), "bad\n")
  assert.equal(readFileSync(files.drip, "utf8"), "progress\n")
})

test("external process-group termination publishes cancellation", async () => {
  const { files, job, pgid } = await fixture('echo ready >> "$PERK_DRIP"; sleep 30')
  await until(() => readFileSync(files.drip, "utf8").includes("ready"))
  assert.equal(killJob(pgid), true)
  await finish(job)
  assert.equal(readFileSync(files.exit, "utf8"), "cancelled:TERM\n")
})

for (const first of ["cancelled", "timeout", "shutdown"] as const) {
  test(`${first} keeps its reason and escalates for a TERM-resistant descendant`, async () => {
    const { files, job, pgid } = await fixture(
      `sh -c 'trap "" TERM; echo ready >> "$PERK_DRIP"; while :; do sleep 1; done'`,
    )
    await until(() => readFileSync(files.drip, "utf8").includes("ready"))
    const now = performance.now()
    job.requestStop(first, now)
    job.requestStop(first === "timeout" ? "cancelled" : "timeout", now + 1)
    job.observe(now + TERMINATION_GRACE_MS - 1)
    assert.equal(existsSync(files.exit), false)
    job.observe(now + TERMINATION_GRACE_MS)
    await finish(job)
    assert.equal(readFileSync(files.exit, "utf8"), first === "cancelled" ? "cancelled:TERM\n" : `${first}\n`)
    assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" })
  })
}

test("a completed result wins over a late deadline", async () => {
  const { files, job } = await fixture("exit 7")
  await until(() => existsSync(files.result))
  job.requestStop("timeout", performance.now())
  assert.equal(readFileSync(files.exit, "utf8"), "7\n")
})

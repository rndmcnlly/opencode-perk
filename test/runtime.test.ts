import assert from "node:assert/strict"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { test } from "node:test"
import { requestCancellation } from "../openchamber-extension/service/jobs.js"
import { PerkRuntime } from "../src/runtime.js"
import { SPOOL_DIR, type LaunchRecord } from "../src/spool.js"

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
    const job = await runtime.launch(
      "sleep 30",
      process.cwd(),
      "session-observer",
      async () => {},
      1,
      "Check external observation",
      30,
    )
    dir = job.dir
    const metadata = JSON.parse(
      readFileSync(`${job.dir}/launch.json`, "utf8"),
    ) as LaunchRecord

    assert.equal(metadata.schema, 1)
    assert.equal(metadata.id, job.id)
    assert.equal(metadata.sessionId, "session-observer")
    assert.equal(metadata.label, "Check external observation")
    assert.equal(metadata.command, "sleep 30")
    assert.equal(metadata.cwd, process.cwd())
    assert.equal(metadata.pgid, job.pgid)
    assert.equal(metadata.expectedSeconds, 30)
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
    const job = await runtime.launch(
      "sleep 30",
      process.cwd(),
      "session-cancel",
      async () => {},
    )
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

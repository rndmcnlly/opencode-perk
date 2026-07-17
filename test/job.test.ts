import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { killJob, spawnBackground } from "../src/job.js"
import { makeJobFiles } from "../src/spool.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "perk-job-test-"))
  roots.push(root)
  return { root, files: makeJobFiles(join(root, "spool")) }
}

async function waitFor(path: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test("wrapper captures streams, drip, and a nonzero exit", async () => {
  const { root, files } = fixture()
  await spawnBackground(
    [
      "echo hello",
      "echo bad >&2",
      'echo progress >> "$PERK_DRIP"',
      "exit 17 # trailing comments stay inside the command",
    ].join("\n"),
    files,
    root,
  )
  await waitFor(files.exit)

  assert.equal(readFileSync(files.exit, "utf8"), "17\n")
  assert.equal(readFileSync(files.out, "utf8"), "hello\n")
  assert.equal(readFileSync(files.err, "utf8"), "bad\n")
  assert.equal(readFileSync(files.drip, "utf8"), "progress\n")
})

test("process-group termination publishes cancellation", async () => {
  const { root, files } = fixture()
  const pgid = await spawnBackground("sleep 30", files, root)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(killJob(pgid), true)
  await waitFor(files.exit)
  assert.equal(readFileSync(files.exit, "utf8"), "cancelled:TERM\n")
})

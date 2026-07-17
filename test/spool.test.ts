import assert from "node:assert/strict"
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  makeJobFiles,
  ensureSpoolDir,
  RETENTION_MS,
  sweepCompletedJobs,
} from "../src/spool.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function temporarySpool() {
  const root = mkdtempSync(join(tmpdir(), "perk-spool-test-"))
  roots.push(root)
  return join(root, "spool")
}

test("makeJobFiles creates a private job directory and drip fiber", () => {
  const files = makeJobFiles(temporarySpool())

  assert.match(files.id, /^[0-9a-f]{8}$/)
  assert.equal(statSync(files.dir).mode & 0o777, 0o700)
  assert.equal(statSync(files.drip).mode & 0o777, 0o600)
  assert.ok(files.dripIdentity)
})

test("spool setup does not change its shared parent permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "perk-parent-test-"))
  roots.push(root)
  const parent = join(root, "opencode")
  mkdirSync(parent)
  chmodSync(parent, 0o750)

  ensureSpoolDir(parent, join(parent, "perk"))

  assert.equal(statSync(parent).mode & 0o777, 0o750)
  assert.equal(statSync(join(parent, "perk")).mode & 0o777, 0o700)
})

test("sweep removes only old completed jobs", () => {
  const spool = temporarySpool()
  mkdirSync(spool, { recursive: true })
  const now = Date.now()

  const old = join(spool, "11111111")
  mkdirSync(old)
  writeFileSync(join(old, "exit"), "0\n")
  const oldTime = new Date(now - RETENTION_MS - 1000)
  utimesSync(join(old, "exit"), oldTime, oldTime)

  const recent = join(spool, "22222222")
  mkdirSync(recent)
  writeFileSync(join(recent, "exit"), "0\n")

  const active = join(spool, "33333333")
  mkdirSync(active)

  const swept: string[] = []
  sweepCompletedJobs(spool, now, (id) => swept.push(id))

  assert.deepEqual(swept, ["11111111"])
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(recent), true)
  assert.equal(existsSync(active), true)
})

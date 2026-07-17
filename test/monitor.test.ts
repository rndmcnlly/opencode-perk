import assert from "node:assert/strict"
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { Monitor } from "../src/monitor.js"
import { makeJobFiles, type JobFiles } from "../src/spool.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "perk-monitor-test-"))
  roots.push(root)
  const files = makeJobFiles(join(root, "spool"))
  const messages: string[] = []
  const monitor = new Monitor()
  const inject = async (_sessionID: string, message: string) => {
    messages.push(message)
  }
  add(monitor, files, inject)
  return { files, messages, monitor }
}

function add(
  monitor: Monitor,
  files: JobFiles,
  inject: (sessionID: string, message: string) => Promise<void>,
) {
  monitor.add({
    inject,
    sessionID: "session-1",
    id: files.id,
    exit: files.exit,
    out: files.out,
    err: files.err,
    drip: files.drip,
    pgid: 123,
    dripOffset: 0,
    dripSeen: 0,
    dripIdentity: files.dripIdentity,
  })
}

test("a burst fires after one quiet tick", async () => {
  const { files, messages, monitor } = fixture()
  appendFileSync(files.drip, "line a\nline b\n")

  monitor.tick()
  await monitor.settled()
  assert.deepEqual(messages, [])

  monitor.tick()
  await monitor.settled()
  assert.deepEqual(messages, [`Spike from job ${files.id}:\nline a\nline b`])
})

test("completion flushes final drip before the terminal event", async () => {
  const { files, messages, monitor } = fixture()
  appendFileSync(files.drip, "final note\n")
  writeFileSync(files.out, "hello\n")
  writeFileSync(files.err, "bad\n")
  writeFileSync(files.exit, "5\n")

  monitor.tick()
  await monitor.settled()

  assert.deepEqual(messages, [
    `Spike from job ${files.id}:\nfinal note`,
    `Job ${files.id} exited 5: out 6 bytes, err 4 bytes`,
  ])
  assert.equal(monitor.listeners.size, 0)
})

test("UTF-8 split across settled reads is decoded once complete", async () => {
  const { files, messages, monitor } = fixture()
  appendFileSync(files.drip, Buffer.from([0xe2]))
  monitor.tick()
  monitor.tick()
  await monitor.settled()
  assert.deepEqual(messages, [])

  appendFileSync(files.drip, Buffer.from([0x82, 0xac, 0x0a]))
  monitor.tick()
  monitor.tick()
  await monitor.settled()
  assert.deepEqual(messages, [`Spike from job ${files.id}:\n€`])
})

test("replacing drip emits a diagnostic and reads the new fiber", async () => {
  const { files, messages, monitor } = fixture()
  renameSync(files.drip, `${files.drip}.old`)
  writeFileSync(files.drip, "after\n")

  monitor.tick()
  monitor.tick()
  await monitor.settled()

  assert.deepEqual(messages, [
    `Spike from job ${files.id}:\n` +
      `[perk: drip file was truncated or replaced; decoding restarted]`,
    `Spike from job ${files.id}:\nafter`,
  ])
})

test("slow injection cannot reorder events from later ticks", async () => {
  const root = mkdtempSync(join(tmpdir(), "perk-order-test-"))
  roots.push(root)
  const first = makeJobFiles(join(root, "spool"))
  const second = makeJobFiles(join(root, "spool"))
  const messages: string[] = []
  let releaseFirst!: () => void
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const monitor = new Monitor()
  const inject = async (_sessionID: string, message: string) => {
    if (messages.length === 0) await firstBlocked
    messages.push(message)
  }

  add(monitor, first, inject)
  writeFileSync(first.exit, "0\n")
  monitor.tick()
  add(monitor, second, inject)
  writeFileSync(second.exit, "2\n")
  monitor.tick()

  releaseFirst()
  await monitor.settled()
  assert.deepEqual(messages, [
    `Job ${first.id} exited 0: out 0 bytes, err 0 bytes`,
    `Job ${second.id} exited 2: out 0 bytes, err 0 bytes`,
  ])
})

test("each listener delivers through the client that launched it", async () => {
  const root = mkdtempSync(join(tmpdir(), "perk-owner-test-"))
  roots.push(root)
  const first = makeJobFiles(join(root, "spool"))
  const second = makeJobFiles(join(root, "spool"))
  const firstMessages: string[] = []
  const secondMessages: string[] = []
  const monitor = new Monitor()

  add(monitor, first, async (_sessionID, message) => {
    firstMessages.push(message)
  })
  add(monitor, second, async (_sessionID, message) => {
    secondMessages.push(message)
  })
  writeFileSync(first.exit, "0\n")
  writeFileSync(second.exit, "3\n")

  monitor.tick()
  await monitor.settled()
  assert.deepEqual(firstMessages, [
    `Job ${first.id} exited 0: out 0 bytes, err 0 bytes`,
  ])
  assert.deepEqual(secondMessages, [
    `Job ${second.id} exited 3: out 0 bytes, err 0 bytes`,
  ])
})

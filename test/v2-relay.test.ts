import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import { Session } from "@opencode/schema/session"
import { ProgressRelay } from "../src-v2/relay.js"

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function fixture(quietMs = 1_000, maxBytes = 16 * 1_024) {
  const root = mkdtempSync(join(tmpdir(), "perk-v2-relay-"))
  roots.push(root)
  const file = join(root, "output")
  writeFileSync(file, "")
  const relay = new ProgressRelay(quietMs, maxBytes)
  relay.created({ id: "sh_test", command: "build", file })
  relay.background("sh_test", Session.ID.make("ses_test"), "build")
  return { file, relay }
}

test("coalesces native shell output after a quiet interval", () => {
  const { file, relay } = fixture()
  appendFileSync(file, "phase one\nphase two\n")

  assert.deepEqual(relay.tick(0), [])
  assert.deepEqual(relay.tick(999), [])
  const spikes = relay.tick(1_000)
  assert.deepEqual(spikes, [
    {
      sessionID: "ses_test",
      shellID: "sh_test",
      command: "build",
      text: "phase one\nphase two",
      cursor: 20,
    },
  ])
  relay.acknowledge(spikes[0]!)
})

test("does not observe a shell until both lifecycle and tool metadata arrive", () => {
  const root = mkdtempSync(join(tmpdir(), "perk-v2-correlation-"))
  roots.push(root)
  const file = join(root, "output")
  writeFileSync(file, "early\n")
  const relay = new ProgressRelay(10)

  relay.created({ id: "sh_test", command: "build", file })
  assert.deepEqual(relay.tick(0), [])
  relay.background("sh_test", Session.ID.make("ses_test"), "build")
  assert.deepEqual(relay.tick(1), [])
  const spike = relay.tick(11)[0]!
  assert.equal(spike.text, "early")
  relay.acknowledge(spike)
})

test("stops without duplicating core's final completion", () => {
  const { file, relay } = fixture(10)
  appendFileSync(file, "unfinished burst\n")
  relay.tick(0)
  relay.exited("sh_test")

  assert.deepEqual(relay.tick(100), [])
})

test("bounds a progress turn and advances past omitted output", () => {
  const { file, relay } = fixture(10, 5)
  appendFileSync(file, "0123456789")
  relay.tick(0)

  const spikes = relay.tick(10)
  assert.deepEqual(spikes, [
    {
      sessionID: "ses_test",
      shellID: "sh_test",
      command: "build",
      text: "[perk: 5 earlier bytes omitted]\n56789",
      cursor: 10,
    },
  ])
  relay.acknowledge(spikes[0]!)
  assert.deepEqual(relay.tick(20), [])
})

test("retries an unacknowledged spike without advancing its cursor", () => {
  const { file, relay } = fixture(10)
  appendFileSync(file, "retry me\n")
  relay.tick(0)
  const first = relay.tick(10)[0]!

  relay.retry(first)
  const retry = relay.tick(11)[0]!
  assert.equal(retry.text, "retry me")
  assert.equal(retry.cursor, first.cursor)
})

test("caps output only at complete UTF-8 boundaries", () => {
  const { file, relay } = fixture(10, 5)
  appendFileSync(file, "ab€cd")
  relay.tick(0)

  const spike = relay.tick(10)[0]!
  assert.equal(spike.text, "[perk: 2 earlier bytes omitted]\n€cd")
  assert.equal(spike.cursor, Buffer.byteLength("ab€cd"))
})

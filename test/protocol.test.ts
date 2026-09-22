import assert from "node:assert/strict"
import { test } from "node:test"
import { describeOutcome, parseLaunch } from "../src/protocol.js"

const base = {
  id: "12345678", sessionId: "session-1", command: "sleep 20", cwd: "/tmp",
  pgid: 123, startedAt: "2026-09-17T12:00:00.000Z",
}

test("normalizes legacy seconds without inventing a deadline", () => {
  assert.deepEqual(parseLaunch({ ...base, schema: 1, expectedSeconds: 0.25 }, base.id), {
    ...base, expectedMs: 250,
  })
})

test("reads transitional and current millisecond launch records", () => {
  for (const schema of [1, 2]) {
    assert.deepEqual(parseLaunch({ ...base, schema, timeoutMs: 1000, expectedMs: 250 }, base.id), {
      ...base, timeoutMs: 1000, expectedMs: 250,
    })
  }
})

test("rejects unknown versions and invalid duration contracts", () => {
  for (const extra of [
    { schema: 3, timeoutMs: 1000 }, { schema: 2 },
    { schema: 2, timeoutMs: 0 }, { schema: 2, timeoutMs: 0.5 },
    { schema: 2, timeoutMs: Infinity },
    { schema: 1, expectedSeconds: -1 },
    { schema: 1, expectedSeconds: Number.MAX_VALUE },
    { schema: 2, timeoutMs: 1000, expectedMs: 0 },
  ]) assert.equal(parseLaunch({ ...base, ...extra }, base.id), null)
  assert.equal(parseLaunch({ ...base, schema: 1 }, "different-id"), null)
})

test("all observers share outcome semantics", () => {
  assert.equal(describeOutcome("timeout", 1000), "timed out after 1000 ms")
  assert.equal(describeOutcome("timeout"), "timed out")
  assert.equal(describeOutcome("shutdown"), "stopped on shutdown")
  assert.equal(describeOutcome("cancelled:TERM"), "cancelled by TERM")
  assert.equal(describeOutcome("17"), "exited 17")
})

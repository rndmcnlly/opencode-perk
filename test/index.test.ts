import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { Perk } from "../src/index.js"

test("injected job turns carry a machine-readable perk origin", async () => {
  type Request = {
    path: { id: string }
    body: { parts: Array<{ type: string; text: string; metadata?: Record<string, unknown> }> }
  }
  const calls: Request[] = []
  const hooks = await Perk({
    client: { session: { promptAsync: async (input: Request) => { calls.push(input) } } },
  } as unknown as PluginInput)
  const tool = hooks.tool?.bash_background
  assert.ok(tool)
  const context: ToolContext = {
    sessionID: "session-test", messageID: "message", agent: "build",
    directory: tmpdir(), worktree: tmpdir(), abort: new AbortController().signal,
    metadata() {}, ask: async () => {},
  }
  let jobDir: string | undefined
  try {
    const result = await tool.execute({ command: "echo ready >> \"$PERK_DRIP\"", coalesce_ms: 300 }, context)
    assert.ok(typeof result === "string")
    jobDir = result.match(/Files: (.*?)\/\{out,err,drip,exit\}/)?.[1]
    assert.ok(jobDir)

    const deadline = Date.now() + 3000
    while (calls.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(calls.length, 2) // final drip spike, then completion
    assert.match(calls[0].body.parts[0].text, /^Spike from job /)
    assert.match(calls[1].body.parts[0].text, /^Job /)
    for (const call of calls) {
      assert.equal(call.body.parts[0].type, "text")
      assert.deepEqual(call.body.parts[0].metadata, { source: "opencode-perk" })
      assert.deepEqual(call.path, { id: "session-test" })
    }
  } finally {
    await hooks.dispose?.()
    if (jobDir) rmSync(jobDir, { recursive: true, force: true })
  }
})

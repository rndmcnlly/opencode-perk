import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { tool as schemaTool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import { PerkRuntime } from "../src/runtime.js"
import { createBackgroundTool } from "../src/tool.js"
import type { LaunchRecord } from "../src/protocol.js"

for (const kind of ["default", "relative", "absolute"] as const) {
  test(`tool executes in the ${kind} workdir with millisecond settings`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "perk-tool-test-")))
    const subdir = join(root, "space in directory")
    mkdirSync(subdir)
    const runtime = new PerkRuntime()
    const tool = createBackgroundTool(runtime, async () => {})
    const context: ToolContext = {
      sessionID: "session-tool", messageID: "message", agent: "build",
      directory: root, worktree: root, abort: new AbortController().signal,
      metadata() {}, ask: async () => {},
    }
    let jobDir: string | undefined
    try {
      const schema = schemaTool.schema.object(tool.args)
      const args = schema.parse({
        command: "pwd",
        ...(kind === "default" ? {} : {
          workdir: kind === "relative" ? "space in directory" : subdir,
          timeout: 10_000, coalesce_ms: 50, expected_ms: 250,
        }),
      })
      const result = await tool.execute(args, context)
      assert.equal(typeof result, "string")
      const listener = [...runtime.monitor.listeners.values()][0]
      jobDir = join(listener.exit, "..")
      const metadata = JSON.parse(readFileSync(join(jobDir, "launch.json"), "utf8")) as LaunchRecord
      assert.equal(metadata.cwd, kind === "default" ? root : subdir)
      assert.equal(metadata.timeoutMs, kind === "default" ? 3_600_000 : 10_000)
      assert.equal(metadata.expectedMs, kind === "default" ? undefined : 250)
      assert.equal(listener.quietMs, kind === "default" ? 1000 : 300)
      const deadline = performance.now() + 3000
      while (runtime.monitor.listeners.size) {
        if (performance.now() > deadline) throw new Error("Tool job did not complete")
        runtime.monitor.tick()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(readFileSync(join(jobDir, "out"), "utf8").trim(), metadata.cwd)
    } finally {
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
      if (jobDir) rmSync(jobDir, { recursive: true, force: true })
    }
  })
}

test("tool rejects fractional, nonfinite, and nonpositive millisecond durations", () => {
  const runtime = new PerkRuntime()
  const tool = createBackgroundTool(runtime, async () => {})
  const schema = schemaTool.schema.object(tool.args)
  for (const field of ["timeout", "expected_ms", "coalesce_ms"]) {
    for (const value of [0, -1, 0.5, Infinity, NaN]) {
      assert.equal(schema.safeParse({ command: "true", [field]: value }).success, false)
    }
  }
})

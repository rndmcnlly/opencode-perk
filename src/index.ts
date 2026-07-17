/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * The OpenCode adapter stays deliberately small. Process execution, spool
 * security, observation, and lifecycle policy live in independently testable
 * modules behind PerkRuntime.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { PerkRuntime } from "./runtime.js"
import { createBackgroundTool } from "./tool.js"

// Named and default exports share one module instance. A separately loaded npm
// copy intentionally gets its own runtime, so a later project-local plugin uses
// the checkout's implementation rather than npm's already-created singleton.
const runtime = new PerkRuntime()
let owners = 0

export const Perk: Plugin = async ({ client }) => {
  owners += 1
  let disposed = false
  const inject = async (sessionID: string, message: string) => {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: message }] },
    })
  }
  runtime.start()

  return {
    dispose: async () => {
      if (disposed) return
      disposed = true
      owners -= 1
      if (owners === 0) await runtime.dispose()
    },
    "shell.env": async (
      _input: unknown,
      output: { env: Record<string, string> },
    ) => {
      // A nested opencode inherits its parent's environment. Only a fresh
      // background wrapper should expose a job-local drip path.
      output.env.PERK_DRIP = ""
    },
    tool: { bash_background: createBackgroundTool(runtime, inject) },
  } as any
}

export default Perk

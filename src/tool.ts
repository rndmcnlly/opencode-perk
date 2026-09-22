import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import type { Injector } from "./monitor.js"
import type { PerkRuntime } from "./runtime.js"
import { DEFAULT_TIMEOUT_MS, DEFAULT_COALESCE_MS, MIN_COALESCE_MS } from "./protocol.js"

const description =
  "Run a shell command as a detached background job and return immediately. " +
  "Use this for long work you do not want to block on; unlike builtin bash, " +
  "perk wakes you when the job finishes. Give the command without adding " +
  "nohup, &, disown, redirection, or output paths. perk returns the job's pgid " +
  "and <job-dir>/{out,err,drip,exit}, then injects its exit result and captured " +
  "output sizes on completion. For interim progress, append messages to " +
  "$PERK_DRIP. After no new writes for coalesce_ms, perk delivers the " +
  `accumulated text as one spike (default ${DEFAULT_COALESCE_MS} ms; values below ${MIN_COALESCE_MS} are ` +
  `clamped). Timeout defaults to ${DEFAULT_TIMEOUT_MS} ms. Stop a job with ` +
  "`kill -TERM -<pgid>`; the leading minus targets its process group. In an " +
  "interactive session, end your turn and wait for injected events. In " +
  "headless `opencode run`, wait in foreground bash on the returned exit file " +
  "so the process remains alive."

export function createBackgroundTool(runtime: PerkRuntime, inject: Injector) {
  return tool({
    description,
    args: {
      command: tool.schema.string().describe(
        "The shell command to run in the background (just the work, e.g. " +
          "'make build' or 'npm run dev'). No nohup/&/disown/redirection " +
          "and no output paths; perk adds detachment and captures " +
          "stdout/stderr for you. May be multi-line; EVERY line is " +
          "executed as shell under `set -e` (abort on first error), so a " +
          "comment needs a literal leading `#`, a bare descriptive line " +
          "(a human-style label) will be run and fail the job, and a line " +
          "you EXPECT to fail must opt out with `|| true`.",
      ),
      timeout: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Maximum runtime in milliseconds before the job's process group is " +
            `sent TERM, then KILL after a short grace period if needed. Defaults to ${DEFAULT_TIMEOUT_MS} (one hour).`,
        ),
      workdir: tool.schema
        .string()
        .optional()
        .describe(
          "The working directory to run the command in. Defaults to the " +
            "current session directory.",
        ),
      label: tool.schema
        .string()
        .max(100)
        .optional()
        .describe(
          "Short phrase describing why this heavyweight job is being run. " +
            "Used as its display label; omit when the command is already " +
            "self-explanatory.",
        ),
      expected_ms: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Approximate wall-clock duration in milliseconds for display only. " +
            "This does not impose a timeout. Omit it when duration is not meaningfully " +
            "predictable.",
        ),
      coalesce_ms: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Quiet time in milliseconds before accumulated $PERK_DRIP writes " +
            `are delivered as one spike. Defaults to ${DEFAULT_COALESCE_MS}; values below ${MIN_COALESCE_MS} ` +
            "are clamped.",
        ),
    },
    async execute(args, ctx) {
      const job = await runtime.launch({
        command: args.command,
        cwd: resolve(ctx.directory, args.workdir ?? "."),
        sessionID: ctx.sessionID,
        inject,
        timeoutMs: args.timeout,
        label: args.label,
        expectedMs: args.expected_ms,
        coalesceMs: args.coalesce_ms,
      })
      return (
        `Backgrounded ${job.id} (detached, pgid ${job.pgid}). ` +
        `Files: ${job.dir}/{out,err,drip,exit}. ` +
        `To kill the whole job tree: kill -TERM -${job.pgid} ` +
        `(the leading minus targets the process group; do not drop it).`
      )
    },
  })
}

import { tool } from "@opencode-ai/plugin"
import type { Injector } from "./monitor.js"
import type { PerkRuntime } from "./runtime.js"

const description =
  "Run a shell command as a detached, fire-and-forget background job " +
  "and get woken (via perk) when it finishes. This is NOT the builtin " +
  "bash: that one blocks until the command exits and hands you its " +
  "output; this one returns IMMEDIATELY (before the command finishes) " +
  "so you keep control of your turn. perk captures stdout/stderr/exit " +
  "code in a private job directory under opencode's temporary dir and " +
  "watches the exit file, which is written ONLY when the job is truly " +
  "done (its output files are complete first), making it a sound " +
  "completion gate. On completion perk injects a turn reporting the " +
  "exit code and the byte sizes of the captured output. Use it for " +
  "long-running work you do not want to block on (builds, downloads, " +
  "test suites, dev/preview servers, agent runs). Give just the command " +
  "(e.g. 'make build' or 'npm run dev'): do NOT add nohup/&/disown/" +
  "redirection or choose output paths; perk handles detachment and " +
  "capture. What lands in your transcript is exactly the command you " +
  "typed. The tool returns the capture path expression " +
  "(<job-dir>/{out,err,drip,exit}) and the job's pgid. STREAMING " +
  "(drip): a still-running job can push interim events back to you " +
  "WITHOUT re-arming a new job by appending to the file named in " +
  "$PERK_DRIP (set automatically inside the job), e.g. " +
  "`echo \"built page 3\" >> \"$PERK_DRIP\"`. perk tails that file and " +
  "coalesces writes by quiet gaps: a burst of appends that goes quiet " +
  "for ~300ms is delivered as ONE turn (a 'spike'); writes separated by " +
  "a longer gap arrive as separate spikes. So a quiet gap is the " +
  "implicit message delimiter (sleep ~0.5s between events you want " +
  "delivered separately; no framing protocol needed). This makes one " +
  "bash_background call a continuous incoming stream: zero or more " +
  "spike turns while it runs, then one exit turn. Every injected turn " +
  "names its short job ID so you can disambiguate interleaved streams " +
  "from concurrent jobs. KILL a job (e.g. a preview server or a " +
  "long-lived watcher) with `kill -TERM -<pgid>` (note the leading " +
  "minus: it signals the whole process group). The wrapper publishes a " +
  "cancelled:TERM terminal result, so exit-file waiters resolve after " +
  "that documented kill path. Jobs also die automatically when opencode " +
  "shuts down gracefully. WAKING: if a human is present (interactive), " +
  "end your turn and go idle; perk injects spike/completion turns as " +
  "they occur. If NO human is present (headless, e.g. `opencode run`), " +
  "ending your turn exits the process and the wake lands in nothing, so " +
  "instead block in FOREGROUND bash on the returned exit file: " +
  "`until [ -e <exit-file> ]; do sleep 0.3; done` then read it (and the " +
  "drip file for any interim events)."

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
    },
    async execute(args, ctx) {
      const job = await runtime.launch(
        args.command,
        ctx.directory,
        ctx.sessionID,
        inject,
      )
      return (
        `Backgrounded ${job.id} (detached, pgid ${job.pgid}). ` +
        `Files: ${job.dir}/{out,err,drip,exit}. ` +
        `To kill the whole job tree: kill -TERM -${job.pgid} ` +
        `(the leading minus targets the process group; do not drop it).`
      )
    },
  })
}

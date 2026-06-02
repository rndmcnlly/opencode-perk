/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * One primitive: bash_background. The model fires a shell command as a
 * detached background job and regains control of its turn IMMEDIATELY. When the
 * job finishes, perk injects a conversational turn into the (idle) session
 * reporting the exit code and the byte sizes of the captured stdout/stderr.
 * That is the whole product: the world (a finishing job) produces a turn, just
 * as a human typing would. The human and the world become peers feeding one
 * serialized conversation.
 *
 * A running job can also DRIP interim events back: appending to $PERK_DRIP
 * (echo ... >> "$PERK_DRIP") makes one bash_background call a continuous
 * afferent stream rather than a single end-of-job signal. perk tails the drip
 * file and performs temporal summation: a burst of appends that settles for one
 * refractory window (~one poll interval) is fired as a single turn (a "spike");
 * writes spaced further apart fire as separate spikes. The quiet gap is the
 * implicit message delimiter, so the job needs no framing protocol. A streaming
 * job's natural history is zero-or-more spikes, then one terminal exit turn. A
 * job that never touches $PERK_DRIP behaves exactly as the one-shot original.
 *
 * Job lifetime (validated against opencode 1.15.13):
 *   - detached: true  -> the job is its own process-group leader, so child.pid
 *                        IS the process-group id (PGID). That doubles as a kill
 *                        handle: `kill -TERM -<pgid>` reaps the whole tree
 *                        (wrapper + the user command + anything it spawned).
 *   - child.unref()   -> the job does not hold opencode's event loop open, so
 *                        the tool returns at once and opencode can still exit.
 *   - dispose reap    -> opencode calls the plugin's dispose hook on shutdown
 *                        (confirmed for `opencode run`); we group-kill every
 *                        tracked job there, so jobs die with opencode on a
 *                        graceful exit. A hard crash / kill -9 of opencode is
 *                        the one case that orphans them (uncatchable); the
 *                        returned PGID is the manual remedy.
 *
 * Why a dedicated tool and not a flag on the builtin bash: a bash hook had to
 * silently rewrite the agent's `command` into detach scaffolding, and that
 * rewritten command was what landed in the transcript. Since the transcript is
 * the agent's only memory, the agent would later read scaffolding it never typed
 * and conclude it had erred. A dedicated tool records exactly what the agent
 * typed; the scaffolding lives inside the implementation.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  statSync,
  appendFileSync,
  readFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Sense organs. perk watches two files per job:
//
//   .exit  ONE-SHOT and atomic (temp + rename), written once when the job is
//          done and its .out/.err are complete. A successful read is itself the
//          completion signal: read it, fire the terminal turn, retire the
//          listener.
//
//   .drip  APPEND-ONLY afferent fiber. A long-running job appends interim events
//          to it (echo ... >> "$PERK_DRIP") without ever re-arming a new job.
//          perk tails it from a byte cursor and performs TEMPORAL SUMMATION: a
//          burst of appends that settles (stops growing for one refractory
//          window) is summed into a single fired turn (a "spike"). Sub-threshold
//          inputs spaced apart fire as separate spikes; rapid inputs coalesce.
//          The drip is the stimulus; the spike is the response; the two rates
//          are deliberately decoupled by the coalescer, exactly as a neuron
//          decouples input rate from firing rate.
//
// size() reports captured-output volume in the terminal turn and is the basis of
// the drip cursor comparison.
// ---------------------------------------------------------------------------

function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// Read the byte range [from, to) of a file as utf8. Used to pull only the
// not-yet-fired tail of a .drip file each time it settles, so perk never
// re-reads or re-fires bytes it has already turned into a spike. A ranged read
// (open/read/close) avoids slurping the whole growing file every tick.
function readRange(path: string, from: number, to: number): string {
  const len = to - from
  if (len <= 0) return ""
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(len)
    const n = readSync(fd, buf, 0, len, from)
    return buf.toString("utf8", 0, n)
  } catch {
    return ""
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Listener state. Every listener watches one job. The .exit file fires once and
// retires the listener; the .drip file may fire many spikes over the job's life.
// A finished job needs no re-arm and no ack.
// ---------------------------------------------------------------------------

type Listener = {
  sessionID: string // which session to wake; captured from ToolContext
  base: string // job_FOO path stem; identifies the job in every turn
  exit: string // the one-shot exit-code file we watch
  out: string // captured stdout path (reported by size)
  err: string // captured stderr path (reported by size)
  drip: string // append-only afferent fiber the job writes interim events to
  pgid: number // process-group id == child.pid; kill handle + listener key
  // Drip cursor (temporal-summation state):
  dripOffset: number // bytes already fired as spikes
  dripSeen: number // file size at the previous tick; growth resets the window
}

const POLL_MS = 300

// ---------------------------------------------------------------------------
// Singleton shared state.
//
// opencode may instantiate the plugin MORE THAN ONCE in a single server
// process; each instantiation gets a fresh closure. Keep all mutable state in
// one object hung off globalThis, shared by every instance. The plugin function
// only wires the live `client` into it and starts the one poll loop (guarded).
// ---------------------------------------------------------------------------

type PerkState = {
  listeners: Map<number, Listener> // keyed by pgid
  jobs: Set<number> // tracked PGIDs, group-killed on dispose
  inject: ((sessionID: string, message: string) => Promise<void>) | null
  pollStarted: boolean
}

const GLOBAL_KEY = "__perk_state__"

function getState(): PerkState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      listeners: new Map(),
      jobs: new Set(),
      inject: null,
      pollStarted: false,
    } satisfies PerkState
  }
  return g[GLOBAL_KEY] as PerkState
}

// Logging: NEVER write to stdout/stderr. When perk runs inside the opencode
// TUI, the renderer owns that surface and our writes corrupt the display.
// Append to a file instead. Opt out / redirect via PERK_LOG (set to "" or "off"
// to silence). Failures here are swallowed: logging must never break the
// channel.
const LOG_PATH =
  process.env.PERK_LOG === undefined ? "/tmp/perk.log" : process.env.PERK_LOG
const log = (...a: unknown[]) => {
  if (!LOG_PATH || LOG_PATH === "off") return
  try {
    const line = a
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ")
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [perk] ${line}\n`)
  } catch {
    // never let logging break the channel
  }
}

function startPoll(S: PerkState) {
  if (S.pollStarted) return
  S.pollStarted = true
  const timer = setInterval(() => {
    // Turns fired this tick, in order. Drip spikes are appended before the
    // terminal exit turn for the same job, so an agent reading the transcript
    // sees a job's interim spikes precede its exit. Every turn names its job
    // (l.base) so interleaved streams from concurrent jobs stay disambiguable.
    const fired: { sessionID: string; message: string }[] = []

    for (const l of S.listeners.values()) {
      // --- Afferent fiber: temporal summation over the .drip file ----------
      // Compare the file's current size to its size last tick. While it is
      // still GROWING we withhold (the burst hasn't settled). Once it stops
      // growing for one refractory window (a single poll interval) AND there
      // are unfired bytes, we sum that tail into one spike and advance the
      // cursor. Bytes spaced more than a window apart therefore fire as
      // separate spikes; bytes within a window coalesce into one.
      const dripSize = size(l.drip)
      if (dripSize > l.dripSeen) {
        // Still growing: arm/extend the window, fire nothing yet.
        l.dripSeen = dripSize
      } else if (dripSize > l.dripOffset) {
        // Settled with unfired bytes: fire a spike carrying the new tail.
        const chunk = readRange(l.drip, l.dripOffset, dripSize)
        l.dripOffset = dripSize
        if (chunk.length > 0) {
          log("spike", { pgid: l.pgid, bytes: chunk.length })
          fired.push({
            sessionID: l.sessionID,
            message: `Spike from background job ${l.base}:\n${chunk.trimEnd()}`,
          })
        }
      }

      // --- Exit: the one-shot terminal signal ------------------------------
      // The exit file is written last, atomically, only when the job is done
      // and .out/.err are complete. A successful read is the completion signal.
      // An absent/unreadable file means not-done-yet; skip and poll again.
      let code: string
      try {
        code = readFileSync(l.exit, "utf8").trim() || "?"
      } catch {
        continue
      }

      // The job ended. Flush any drip tail still unfired (e.g. a final burst
      // written and then the process exited within the same window, so the
      // grow/settle dance never got a quiet tick) as its OWN spike, before the
      // terminal turn. This guarantees no drip byte is ever dropped on exit.
      const finalDrip = readRange(l.drip, l.dripOffset, size(l.drip))
      if (finalDrip.trim().length > 0) {
        log("spike (final)", { pgid: l.pgid, bytes: finalDrip.length })
        fired.push({
          sessionID: l.sessionID,
          message: `Spike from background job ${l.base}:\n${finalDrip.trimEnd()}`,
        })
      }

      const message =
        `Background job ${l.base} exited = ${code}, ` +
        `.out ${size(l.out)} bytes, .err ${size(l.err)} bytes`
      log("fired", { pgid: l.pgid, code })
      fired.push({ sessionID: l.sessionID, message })
      S.listeners.delete(l.pgid)
      S.jobs.delete(l.pgid) // finished; nothing left to reap
    }

    if (fired.length === 0) return
    void (async () => {
      if (!S.inject) return
      for (const f of fired) {
        await S.inject(f.sessionID, f.message).catch((e) =>
          log("inject failed", { error: String(e) }),
        )
      }
    })()
  }, POLL_MS)
  if (typeof timer.unref === "function") timer.unref()
}

// ---------------------------------------------------------------------------
// Backgrounding. Run a user command as a detached fire-and-forget job: the tool
// returns immediately, stdout/stderr are captured to files, and the command's
// bare exit code lands LAST in the exit file (the one-shot completion sentinel).
// ---------------------------------------------------------------------------

function shSingleQuote(s: string): string {
  // Wrap s in single quotes, escaping embedded single quotes as '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Per-job private file set under the project .perk/ dir. The agent learns the
// path expression (job_FOO.{out,err,exit}) from the tool's return value. Using
// the project dir (not /tmp) avoids opencode's external-directory permission
// prompt on access outside the worktree.
type JobFiles = {
  base: string
  exit: string
  out: string
  err: string
  drip: string
}

function makeJobFiles(worktree: string): JobFiles {
  const dir = join(worktree, ".perk")
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `job_${randomBytes(4).toString("hex")}`)
  return {
    base,
    exit: `${base}.exit`,
    out: `${base}.out`,
    err: `${base}.err`,
    drip: `${base}.drip`,
  }
}

// Build the shell script the detached child runs. Run the user command in a
// SUBSHELL (so a bare `exit N` ends only the job), redirect its stdout/stderr to
// the capture files, then write the bare exit code to the exit file ATOMICALLY
// (temp + rename) so a foreground `until [ -e exit ]` waiter never observes a
// half-written file.
//
// The subshell also inherits $PERK_DRIP, the path to this job's append-only drip
// file. A long-running job can `echo ... >> "$PERK_DRIP"` (or `printf`, or
// `tee -a`) to push interim events back to the agent WITHOUT re-arming a new
// bash_background. perk tails that file and coalesces bursts (see startPoll).
//
// NEWLINES, not semicolons, separate the parts: the user command can contain a
// trailing `#` comment, and a `#` runs to end-of-LINE; if `( <command> )` were
// one line, a comment would swallow the closing `)`. Putting the command on its
// own line between a lone `(` and `)` means any comment dies at the newline.
function backgroundScript(command: string, f: JobFiles): string {
  return [
    `export PERK_DRIP=${shSingleQuote(f.drip)}`,
    "(",
    command,
    `) >${shSingleQuote(f.out)} 2>${shSingleQuote(f.err)}`,
    `__perk_code=$?`,
    `echo "$__perk_code" > ${shSingleQuote(f.exit + ".tmp")}`,
    `mv ${shSingleQuote(f.exit + ".tmp")} ${shSingleQuote(f.exit)}`,
  ].join("\n")
}

// Spawn the detached job. Returns the PGID (== child.pid, because detached
// makes the child a process-group leader). The caller tracks it for dispose
// reaping and hands it to the agent as a kill handle.
function spawnBackground(command: string, f: JobFiles, cwd: string): number {
  const child = spawn("sh", ["-c", backgroundScript(command, f)], {
    cwd,
    detached: true,
    stdio: "ignore",
  })
  child.unref()
  return child.pid!
}

// Group-kill a tracked job tree. Negative PID signals the whole process group,
// so the wrapper AND everything the user command spawned go down together.
function killJob(pgid: number): boolean {
  try {
    process.kill(-pgid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

export const Perk: Plugin = async ({ client }) => {
  const S = getState()

  // Wire the live client into the shared injector. Latest instance wins.
  S.inject = async (sessionID, message) => {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: message }] },
    })
  }

  startPoll(S)

  const hooks = {
    // Reap every tracked job on shutdown so jobs die with opencode on a graceful
    // exit (confirmed: dispose fires on `opencode run` teardown). A hard crash /
    // kill -9 of opencode bypasses this; the returned PGID is the manual remedy.
    dispose: async () => {
      for (const pgid of S.jobs) {
        const ok = killJob(pgid)
        log("dispose reap", { pgid, ok })
      }
      S.jobs.clear()
    },

    tool: {
      bash_background: tool({
        description:
          "Run a shell command as a detached, fire-and-forget background job " +
          "and get woken (via perk) when it finishes. This is NOT the builtin " +
          "bash: that one blocks until the command exits and hands you its " +
          "output; this one returns IMMEDIATELY (before the command finishes) " +
          "so you keep control of your turn. perk captures stdout/stderr/exit " +
          "code to files under the project .perk/ dir and watches the exit " +
          "file, which is written ONLY when the job is truly done (its output " +
          "files are complete first), making it a sound completion gate. On " +
          "completion perk injects a turn reporting the exit code and the byte " +
          "sizes of the captured output. Use it for " +
          "long-running work you do not want to block on (builds, downloads, " +
          "test suites, dev/preview servers, agent runs). Give just the command " +
          "(e.g. 'make build' or 'npm run dev'): do NOT add nohup/&/disown/" +
          "redirection or choose output paths; perk handles detachment and " +
          "capture. What lands in your transcript is exactly the command you " +
          "typed. The tool returns the capture path expression " +
          "(.perk/job_FOO.{out,err,exit}) and the job's pid. " +
          "STREAMING (drip): a still-running job can push interim events back " +
          "to you WITHOUT re-arming a new job by appending to the file named in " +
          "$PERK_DRIP (set automatically inside the job), e.g. " +
          "`echo \"built page 3\" >> \"$PERK_DRIP\"`. perk tails that file and " +
          "coalesces writes by quiet gaps: a burst of appends that goes quiet " +
          "for ~300ms is delivered as ONE turn (a 'spike'); writes separated by " +
          "a longer gap arrive as separate spikes. So a quiet gap is the " +
          "implicit message delimiter (sleep ~0.5s between events you want " +
          "delivered separately; no framing protocol needed). This makes one " +
          "bash_background call a continuous incoming stream: zero or more " +
          "spike turns while it runs, then one exit turn when it ends. Every " +
          "injected turn names its job (job_FOO) so you can disambiguate " +
          "interleaved streams from concurrent jobs. " +
          "KILL a job (e.g. a preview server or a long-lived watcher) with " +
          "`kill -TERM -<pid>` (note " +
          "the leading minus: it signals the whole process group). Jobs also " +
          "die automatically when opencode shuts down gracefully. " +
          "WAKING: if a human is present (interactive), end your turn and go " +
          "idle; perk injects spike/completion turns as they occur. If NO " +
          "human is present (headless, e.g. `opencode run`), ending your turn " +
          "exits the process and the wake lands in nothing, so instead block in " +
          "FOREGROUND bash on the returned exit file: " +
          "`until [ -e <exit-file> ]; do sleep 0.3; done` then read it (and " +
          "`cat` the .drip file for any interim events).",
        args: {
          command: tool.schema
            .string()
            .describe(
              "The shell command to run in the background (just the work, e.g. " +
                "'make build' or 'npm run dev'). No nohup/&/disown/redirection " +
                "and no output paths; perk adds detachment and captures " +
                "stdout/stderr for you. May be multi-line and may contain # " +
                "comments.",
            ),
        },
        async execute(args, ctx) {
          const f = makeJobFiles(ctx.directory)
          const pgid = spawnBackground(args.command, f, ctx.directory)
          S.listeners.set(pgid, {
            sessionID: ctx.sessionID,
            base: f.base,
            exit: f.exit,
            out: f.out,
            err: f.err,
            drip: f.drip,
            pgid,
            dripOffset: 0,
            dripSeen: 0,
          })
          S.jobs.add(pgid)
          log("bash_background: spawned", {
            pgid,
            base: f.base,
            cwd: ctx.directory,
          })
          return (
            `Backgrounded (detached, pid ${pgid}). ` +
            `Output captured to ${f.base}.{out,err,exit,drip}.`
          )
        },
      }),
    },
  }

  return hooks as any
}

// Both a named and a default export, matching the flagship community plugins
// (opencode-wakatime, opencode-helicone-session). opencode collects any exported
// plugin function; exporting both hedges against loader iteration order.
export default Perk

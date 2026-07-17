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
 * Job lifetime (validated against opencode 1.18.3):
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
  lstatSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  chmodSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { StringDecoder } from "node:string_decoder"

// ---------------------------------------------------------------------------
// Sense organs. perk watches two files per job:
//
//   exit   ONE-SHOT and atomic (temp + rename), written once when the job is
//          done and its out/err are complete. A successful read is itself the
//          completion signal: read it, fire the terminal turn, retire the
//          listener.
//
//   drip   APPEND-ONLY afferent fiber. A long-running job appends interim events
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

// Read up to the byte range [from, to). The caller advances its cursor by the
// returned byte count, never by the requested count, so a short or failed read
// cannot silently discard drip data. Decoding happens separately through a
// stateful StringDecoder, which preserves UTF-8 sequences split across reads.
function readRange(path: string, from: number, to: number): Buffer {
  const len = to - from
  if (len <= 0) return Buffer.alloc(0)
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(len)
    let n = 0
    while (n < len) {
      const read = readSync(fd, buf, n, len - n, from + n)
      if (read === 0) break
      n += read
    }
    return buf.subarray(0, n)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A close failure must not stop the poll loop.
      }
    }
  }
}

type FileState = { size: number; identity: string }

function fileState(path: string): FileState | null {
  try {
    const stat = statSync(path)
    return { size: stat.size, identity: `${stat.dev}:${stat.ino}` }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Listener state. Every listener watches one job. The exit file fires once and
// retires the listener; the drip file may fire many spikes over the job's life.
// A finished job needs no re-arm and no ack.
// ---------------------------------------------------------------------------

type Listener = {
  sessionID: string // which session to wake; captured from ToolContext
  id: string // short conversational identity; also the artifact dir name
  exit: string // the one-shot exit-code file we watch
  out: string // captured stdout path (reported by size)
  err: string // captured stderr path (reported by size)
  drip: string // append-only afferent fiber the job writes interim events to
  pgid: number // process-group id == child.pid; kill handle
  // Drip cursor (temporal-summation state):
  dripOffset: number // bytes already fired as spikes
  dripSeen: number // file size at the previous tick; growth resets the window
  dripIdentity: string // device/inode pair; detects replacement of the fiber
  dripDecoder: StringDecoder // retains a UTF-8 prefix split across poll reads
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
  listeners: Map<string, Listener> // keyed by stable job id, not reusable PGID
  inject: ((sessionID: string, message: string) => Promise<void>) | null
  pollStarted: boolean
  sweepStarted: boolean
}

// State lives on globalThis because opencode may instantiate the plugin more than
// once in one process. Note the failure mode: if you change the PerkState /
// Listener shape mid-development, an old in-memory instance's poll loop can
// iterate the new shape and misfire (undefined ids, per-tick re-injection).
// Restart opencode after any state-shape change so only one build is live.
const GLOBAL_KEY = "__perk_state__"

function getState(): PerkState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      listeners: new Map(),
      inject: null,
      pollStarted: false,
      sweepStarted: false,
    } satisfies PerkState
  }
  return g[GLOBAL_KEY] as PerkState
}

// Logging: NEVER write to stdout/stderr. When perk runs inside the opencode
// TUI, the renderer owns that surface and our writes corrupt the display.
// Append to a file instead. Logging is off by default. PERK_LOG=1 writes beside
// the spool; any other non-empty value is an explicit path. Failures here are
// swallowed: logging must never break the channel.
const OPENCODE_TMP_DIR = join(tmpdir(), "opencode")
const SPOOL_DIR = join(OPENCODE_TMP_DIR, "perk")
const LOG_SETTING = process.env.PERK_LOG
const LOG_PATH =
  !LOG_SETTING || LOG_SETTING === "off"
    ? ""
    : LOG_SETTING === "1"
      ? join(SPOOL_DIR, "log")
      : LOG_SETTING
const log = (...a: unknown[]) => {
  if (!LOG_PATH) return
  try {
    if (LOG_SETTING === "1") ensureSpoolDir()
    const line = a
      .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ")
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [perk] ${line}\n`, {
      mode: 0o600,
    })
    chmodSync(LOG_PATH, 0o600)
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
    // (l.id) so interleaved streams from concurrent jobs stay disambiguable.
    const fired: { sessionID: string; message: string }[] = []

    for (const l of S.listeners.values()) {
      // --- Afferent fiber: temporal summation over the drip file -----------
      // Compare the file's current size to its size last tick. While it is
      // still GROWING we withhold (the burst hasn't settled). Once it stops
      // growing for one refractory window (a single poll interval) AND there
      // are unfired bytes, we sum that tail into one spike and advance the
      // cursor. Bytes spaced more than a window apart therefore fire as
      // separate spikes; bytes within a window coalesce into one.
      const currentDrip = fileState(l.drip)
      let dripSize = currentDrip?.size ?? 0
      if (
        currentDrip &&
        (currentDrip.identity !== l.dripIdentity || dripSize < l.dripOffset)
      ) {
        // The public contract is append-only. If a command violates it, reset
        // coherently and tell the conversation rather than silently dropping,
        // duplicating, or decoding bytes against stale UTF-8 state.
        l.dripIdentity = currentDrip.identity
        l.dripOffset = 0
        l.dripSeen = 0
        l.dripDecoder = new StringDecoder("utf8")
        fired.push({
          sessionID: l.sessionID,
          message:
            `Spike from job ${l.id}:\n` +
            `[perk: drip file was truncated or replaced; decoding restarted]`,
        })
      }
      if (dripSize > l.dripSeen) {
        // Still growing: arm/extend the window, fire nothing yet.
        l.dripSeen = dripSize
      } else if (dripSize > l.dripOffset) {
        // Settled with unfired bytes: fire a spike carrying the new tail.
        const bytes = readRange(l.drip, l.dripOffset, dripSize)
        l.dripOffset += bytes.length
        const chunk = l.dripDecoder.write(bytes)
        if (chunk.trim().length > 0) {
          log("spike", { pgid: l.pgid, bytes: bytes.length })
          fired.push({
            sessionID: l.sessionID,
            message: `Spike from job ${l.id}:\n${chunk.trimEnd()}`,
          })
        }
      }

      // --- Exit: the one-shot terminal signal ------------------------------
      // The exit file is written last, atomically, only when the job is done
      // and out/err are complete. A successful read is the completion signal.
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
      const finalState = fileState(l.drip)
      if (
        finalState &&
        (finalState.identity !== l.dripIdentity || finalState.size < l.dripOffset)
      ) {
        l.dripIdentity = finalState.identity
        l.dripOffset = 0
        l.dripDecoder = new StringDecoder("utf8")
        fired.push({
          sessionID: l.sessionID,
          message:
            `Spike from job ${l.id}:\n` +
            `[perk: drip file was truncated or replaced; decoding restarted]`,
        })
      }
      const finalSize = finalState?.size ?? 0
      const finalBytes = readRange(l.drip, l.dripOffset, finalSize)
      l.dripOffset += finalBytes.length
      // An exit file says the writer is done. If a transient read still came up
      // short, retain the listener and retry rather than losing the terminal
      // tail or firing the exit turn ahead of it.
      if (l.dripOffset < finalSize) continue
      const finalDrip =
        l.dripDecoder.write(finalBytes) + l.dripDecoder.end()
      if (finalDrip.trim().length > 0) {
        log("spike (final)", { pgid: l.pgid, bytes: finalBytes.length })
        fired.push({
          sessionID: l.sessionID,
          message: `Spike from job ${l.id}:\n${finalDrip.trimEnd()}`,
        })
      }

      const errBytes = size(l.err)
      const outcome = code.startsWith("cancelled:")
        ? `cancelled by ${code.slice("cancelled:".length) || "signal"}`
        : `exited ${code}`
      const message =
        `Job ${l.id} ${outcome}: ` +
        `out ${size(l.out)} bytes, err ${errBytes} bytes`
      log("fired", { pgid: l.pgid, code })
      fired.push({ sessionID: l.sessionID, message })
      S.listeners.delete(l.id)
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

// Per-job private directory under opencode's allowlisted temporary directory.
// This keeps projects clean while letting built-in file tools inspect captures
// without an external-directory prompt.
type JobFiles = {
  id: string
  dir: string
  exit: string
  out: string
  err: string
  drip: string
  dripIdentity: string
}

function ensureSpoolDir() {
  mkdirSync(OPENCODE_TMP_DIR, { recursive: true, mode: 0o700 })
  const parent = lstatSync(OPENCODE_TMP_DIR)
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error(`Unsafe opencode temporary path: ${OPENCODE_TMP_DIR}`)
  }
  if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
    throw new Error(`Opencode temporary path is owned by another user: ${OPENCODE_TMP_DIR}`)
  }
  mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 })
  const info = lstatSync(SPOOL_DIR)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe perk spool path: ${SPOOL_DIR}`)
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`Perk spool is owned by another user: ${SPOOL_DIR}`)
  }
  chmodSync(SPOOL_DIR, 0o700)
}

function makeJobFiles(): JobFiles {
  ensureSpoolDir()
  for (;;) {
    const id = randomBytes(4).toString("hex")
    const dir = join(SPOOL_DIR, id)
    try {
      mkdirSync(dir, { mode: 0o700 })
      const drip = join(dir, "drip")
      closeSync(openSync(drip, "wx", 0o600))
      const dripIdentity = fileState(drip)!.identity
      return {
        id,
        dir,
        exit: join(dir, "exit"),
        out: join(dir, "out"),
        err: join(dir, "err"),
        drip,
        dripIdentity,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
}

const RETENTION_MS = 24 * 60 * 60 * 1000
const SWEEP_MS = 60 * 60 * 1000

function sweepCompletedJobs() {
  const cutoff = Date.now() - RETENTION_MS
  let entries
  try {
    entries = readdirSync(SPOOL_DIR, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}$/.test(entry.name)) continue
    const dir = join(SPOOL_DIR, entry.name)
    try {
      if (statSync(join(dir, "exit")).mtimeMs >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      log("swept", { id: entry.name })
    } catch {
      // No readable exit means active or abandoned: never guess and delete it.
    }
  }
}

function startSweep(S: PerkState) {
  if (S.sweepStarted) return
  S.sweepStarted = true
  sweepCompletedJobs()
  const timer = setInterval(sweepCompletedJobs, SWEEP_MS)
  if (typeof timer.unref === "function") timer.unref()
}

// Build the shell script the detached child runs. Run the user command in a
// SUBSHELL (so a bare `exit N` ends only the job), redirect its stdout/stderr to
// the capture files, then write the exit code to the exit file ATOMICALLY (temp
// + rename) so a foreground `until [ -e exit ]` waiter never observes a
// half-written file. The outer wrapper traps cooperative termination signals
// and publishes `cancelled:<signal>` through the same terminal gate.
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
//
// The subshell runs under `set -e`: the user's command body is executed
// abort-on-error, so the FIRST failing line ends the job with a nonzero code
// instead of being silently stepped over (the classic trap: a bare descriptive
// first line that the shell tries to run, then continues, letting a later
// success mask the failure with exit 0). A line that is EXPECTED to fail must
// opt out the normal shell way, e.g. `somecmd || true`.
function backgroundScript(command: string, f: JobFiles): string {
  return [
    "umask 077",
    "__perk_finish() {",
    "  trap '' HUP INT TERM",
    `  printf '%s\\n' "$1" > ${shSingleQuote(f.exit + ".tmp")}`,
    `  mv ${shSingleQuote(f.exit + ".tmp")} ${shSingleQuote(f.exit)}`,
    "}",
    `trap '__perk_finish "cancelled:HUP"; exit 129' HUP`,
    `trap '__perk_finish "cancelled:INT"; exit 130' INT`,
    `trap '__perk_finish "cancelled:TERM"; exit 143' TERM`,
    `export PERK_DRIP=${shSingleQuote(f.drip)}`,
    "(",
    `set -e`,
    command,
    `) >${shSingleQuote(f.out)} 2>${shSingleQuote(f.err)}`,
    `__perk_code=$?`,
    `__perk_finish "$__perk_code"`,
  ].join("\n")
}

// Spawn the detached job. Returns the PGID (== child.pid, because detached
// makes the child a process-group leader). The caller tracks it for dispose
// reaping and hands it to the agent as a kill handle.
function spawnBackground(command: string, f: JobFiles, cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", backgroundScript(command, f)], {
      cwd,
      detached: true,
      stdio: "ignore",
    })
    child.once("spawn", () => {
      child.unref()
      resolve(child.pid!)
    })
    child.once("error", reject)
  })
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
  startSweep(S)

  const hooks = {
    // Reap every tracked job on shutdown so jobs die with opencode on a graceful
    // exit (confirmed: dispose fires on `opencode run` teardown). A hard crash /
    // kill -9 of opencode bypasses this; the returned PGID is the manual remedy.
    dispose: async () => {
      for (const job of S.listeners.values()) {
        const ok = killJob(job.pgid)
        log("dispose reap", { id: job.id, pgid: job.pgid, ok })
      }
      S.listeners.clear()
    },

    // A nested `opencode run` inherits the outer job's PERK_DRIP. Mask it from
    // that harness's foreground shell tools so they cannot accidentally write
    // into the parent session. A real bash_background wrapper always exports
    // its own job-local path after this environment is inherited.
    "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
      output.env.PERK_DRIP = ""
    },

    tool: {
      bash_background: tool({
        description:
          "Run a shell command as a detached, fire-and-forget background job " +
          "and get woken (via perk) when it finishes. This is NOT the builtin " +
          "bash: that one blocks until the command exits and hands you its " +
          "output; this one returns IMMEDIATELY (before the command finishes) " +
          "so you keep control of your turn. perk captures stdout/stderr/exit " +
          "code in a private job directory under opencode's temporary dir and " +
          "watches the exit " +
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
          "(<job-dir>/{out,err,drip,exit}) and the job's pgid. " +
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
          "injected turn names its short job ID so you can disambiguate " +
          "interleaved streams from concurrent jobs. " +
          "KILL a job (e.g. a preview server or a long-lived watcher) with " +
          "`kill -TERM -<pgid>` (note " +
          "the leading minus: it signals the whole process group). The wrapper " +
          "publishes a cancelled:TERM terminal result, so exit-file waiters " +
          "resolve after that documented kill path. Jobs also die " +
          "automatically when opencode shuts down gracefully. " +
          "WAKING: if a human is present (interactive), end your turn and go " +
          "idle; perk injects spike/completion turns as they occur. If NO " +
          "human is present (headless, e.g. `opencode run`), ending your turn " +
          "exits the process and the wake lands in nothing, so instead block in " +
          "FOREGROUND bash on the returned exit file: " +
          "`until [ -e <exit-file> ]; do sleep 0.3; done` then read it (and " +
          "the drip file for any interim events).",
        args: {
          command: tool.schema
            .string()
            .describe(
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
          const f = makeJobFiles()
          let pgid: number
          try {
            pgid = await spawnBackground(args.command, f, ctx.directory)
          } catch (error) {
            rmSync(f.dir, { recursive: true, force: true })
            throw error
          }
          S.listeners.set(f.id, {
            sessionID: ctx.sessionID,
            id: f.id,
            exit: f.exit,
            out: f.out,
            err: f.err,
            drip: f.drip,
            pgid,
            dripOffset: 0,
            dripSeen: 0,
            dripIdentity: f.dripIdentity,
            dripDecoder: new StringDecoder("utf8"),
          })
          log("bash_background: spawned", {
            id: f.id,
            pgid,
            dir: f.dir,
            cwd: ctx.directory,
          })
          return (
            `Backgrounded ${f.id} (detached, pgid ${pgid}). ` +
            `Files: ${f.dir}/{out,err,drip,exit}. ` +
            `To kill the whole job tree: kill -TERM -${pgid} ` +
            `(the leading minus targets the process group; do not drop it).`
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

/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * One primitive: perk_bash_background. The model fires a shell command as a
 * detached background job and regains control of its turn IMMEDIATELY. When the
 * job finishes, perk injects a conversational turn into the (idle) session
 * reporting the exit code and the sizes/paths of the captured stdout/stderr.
 * That is the whole product: the world (a finishing job) produces a turn, just
 * as a human typing would. The human and the world become peers feeding one
 * serialized conversation.
 *
 * This is the single-primitive rewrite (issue #3). Earlier versions also
 * exposed perk_register / perk_ack / perk_cancel (watch an arbitrary path,
 * re-arm, stop) and perk_wait (a headless blocking escape hatch). All four are
 * gone. The reductions that justify their removal:
 *
 *   - "Watch an arbitrary observable" reduces to a bash job that blocks until
 *     the observable changes, then exits:
 *         perk_bash_background({ command:
 *           "until [ -e some.file ]; do sleep 0.3; done" })
 *     The poll loop that used to live inside the plugin now lives inside the
 *     command. perk keeps exactly ONE sense organ (a job's exit-code file)
 *     instead of two (that file + a generic stat-poll over registered paths).
 *
 *   - ack was just "re-register"; a fresh perk_bash_background per event covers
 *     it. cancel was barely better than neglecting to ack.
 *
 *   - perk_wait existed only because, headless (`opencode run`), ending a turn
 *     exits the process so the injected wake lands in nothing. But the agent can
 *     simply block in FOREGROUND bash on the exit-file path this tool already
 *     returns:
 *         until [ -e <exit-file> ]; do sleep 0.3; done
 *     That is the blocking wait, in plain bash, with no plugin machinery. The
 *     exit file is written only when the job is truly done (see below), so the
 *     loop is a correct completion gate.
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
 * Why a dedicated tool and not a flag on the builtin bash (issue #2): a bash
 * hook had to silently rewrite the agent's `command` into detach scaffolding,
 * and that rewritten command was what landed in the transcript. Since the
 * transcript is the agent's only memory, the agent would later read scaffolding
 * it never typed and conclude it had erred. A dedicated tool records exactly
 * what the agent typed; the scaffolding lives inside the implementation.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { statSync, appendFileSync, readFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Sense organ: snapshot a path's existence + size. The only path perk watches
// is a job's exit-code file, which is ONE-SHOT (written once, when the job is
// done) and atomic (written via temp + rename), so existence alone is a sound
// completion signal. We keep size to report captured-output volume.
// ---------------------------------------------------------------------------

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Listener state. Every listener watches one job's exit file. When that file
// appears, perk injects a completion turn and removes the listener: a finished
// job needs no re-arm and no ack.
// ---------------------------------------------------------------------------

type Listener = {
  id: string
  sessionID: string // which session to wake; captured from ToolContext
  exit: string // the one-shot exit-code file we watch
  out: string // captured stdout path (reported by size)
  err: string // captured stderr path (reported by size)
  pgid: number // process-group id == child.pid; kill handle for the job tree
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
  listeners: Map<string, Listener>
  jobs: Set<number> // tracked PGIDs, group-killed on dispose
  nextId: number
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
      nextId: 1,
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
    const fired: { sessionID: string; message: string }[] = []
    for (const l of S.listeners.values()) {
      if (!exists(l.exit)) continue
      // The exit file appeared: the job is done and .out/.err are complete (the
      // exit file is written last, atomically). Read the bare exit code, build
      // the wake, and remove the listener (one-shot).
      let code = "?"
      try {
        code = readFileSync(l.exit, "utf8").trim() || "?"
      } catch {
        // exit file vanished or unreadable; report what we can
      }
      const verdict =
        code === "0"
          ? "exited cleanly (exit 0)"
          : code === "?"
            ? "finished (exit code unreadable)"
            : `exited with code ${code}`
      const message =
        `[perk:${l.id}] background job ${verdict}. ` +
        `stdout: ${size(l.out)} bytes (${l.out}). ` +
        `stderr: ${size(l.err)} bytes (${l.err}). ` +
        `Read those files only if a size above suggests something useful. ` +
        `The job is done; this listener is gone (no ack needed).`
      log("fired", { id: l.id, code })
      fired.push({ sessionID: l.sessionID, message })
      S.listeners.delete(l.id)
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

// Per-job private file set under the project .perk/ dir. The agent learns these
// paths from the tool's return value. Using the project dir (not /tmp) avoids
// opencode's external-directory permission prompt on access outside the
// worktree.
type JobFiles = { base: string; exit: string; out: string; err: string }

function makeJobFiles(worktree: string, id: string): JobFiles {
  const dir = join(worktree, ".perk")
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `${id}-${randomBytes(3).toString("hex")}`)
  return { base, exit: `${base}.exit`, out: `${base}.out`, err: `${base}.err` }
}

// Build the shell script the detached child runs. Run the user command in a
// SUBSHELL (so a bare `exit N` ends only the job), redirect its stdout/stderr to
// the capture files, then write the bare exit code to the exit file ATOMICALLY
// (temp + rename) so a foreground `until [ -e exit ]` waiter never observes a
// half-written file.
//
// NEWLINES, not semicolons, separate the parts: the user command can contain a
// trailing `#` comment, and a `#` runs to end-of-LINE; if `( <command> )` were
// one line, a comment would swallow the closing `)`. Putting the command on its
// own line between a lone `(` and `)` means any comment dies at the newline.
function backgroundScript(command: string, f: JobFiles): string {
  return [
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
function killJob(pgid: number, sig: NodeJS.Signals = "SIGTERM"): boolean {
  try {
    process.kill(-pgid, sig)
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
      perk_bash_background: tool({
        description:
          "Run a shell command as a detached, fire-and-forget background job " +
          "and get woken (via perk) when it finishes. This is NOT the builtin " +
          "bash: that one blocks until the command exits and hands you its " +
          "output; this one returns IMMEDIATELY (before the command finishes) " +
          "so you keep control of your turn. perk captures stdout/stderr/exit " +
          "code to files under the project .perk/ dir and watches the exit " +
          "file; on completion it injects a turn reporting the exit code and " +
          "the byte sizes + paths of the captured output. Use it for " +
          "long-running work you do not want to block on (builds, downloads, " +
          "test suites, dev/preview servers, agent runs). Give just the command " +
          "(e.g. 'make build' or 'npm run dev'): do NOT add nohup/&/disown/" +
          "redirection or choose output paths; perk handles detachment and " +
          "capture. What lands in your transcript is exactly the command you " +
          "typed. The tool returns the exit/stdout/stderr paths and a PGID. " +
          "KILL a job (e.g. a preview server) with `kill -TERM -<pgid>` (note " +
          "the leading minus: it signals the whole process group). Jobs also " +
          "die automatically when opencode shuts down gracefully. " +
          "WAKING: if a human is present (interactive), end your turn and go " +
          "idle; perk injects the completion turn when the job finishes. If NO " +
          "human is present (headless, e.g. `opencode run`), ending your turn " +
          "exits the process and the wake lands in nothing, so instead block in " +
          "FOREGROUND bash on the returned exit file: " +
          "`until [ -e <exit-file> ]; do sleep 0.3; done` then read it.",
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
          const f = makeJobFiles(ctx.directory, `job_${S.nextId}`)
          const pgid = spawnBackground(args.command, f, ctx.directory)
          const id = `perk_${S.nextId++}`
          S.listeners.set(id, {
            id,
            sessionID: ctx.sessionID,
            exit: f.exit,
            out: f.out,
            err: f.err,
            pgid,
          })
          S.jobs.add(pgid)
          log("perk_bash_background: spawned", {
            id,
            pgid,
            base: f.base,
            cwd: ctx.directory,
          })
          return (
            `Backgrounded as ${id} (running detached now, pgid ${pgid}). ` +
            `perk captures output: stdout -> ${f.out}, stderr -> ${f.err}, ` +
            `exit code -> ${f.exit}. The exit file appears only when the job is ` +
            `truly done (output files complete first), so it is a sound ` +
            `completion gate.\n` +
            `WAKING: if a human is present, end your turn now; perk wakes you ` +
            `with the exit code and output sizes on completion. If you are ` +
            `headless (no human to wake you), do NOT end your turn; block in ` +
            `foreground bash instead: ` +
            `until [ -e ${f.exit} ]; do sleep 0.3; done\n` +
            `KILL this job with: kill -TERM -${pgid}  (leading minus = whole ` +
            `process group). It also dies when opencode shuts down gracefully.`
          )
        },
      }),
    },
  }

  return hooks as any
}

/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * The model registers interest in a filesystem path; when that path changes,
 * perk injects a conversational turn describing the change. That's the whole
 * product.
 *
 * One code path: a stat-poll loop. The native file watcher cannot see
 * arbitrary absolute paths like /tmp (it watches only the project dir and
 * hardcodes a tmp glob in its ignore list), so perk owns its sense organ.
 *
 * This is the radically-simplified rewrite (issue #1). Everything that existed
 * only to make the channel configurable or list-able is gone:
 *   - No perk_list. The agent takes its own notes, or gets harmlessly
 *     re-notified, or never acks. No state kept solely to be displayed.
 *   - No reply/noReply. Every fire is a real turn (always reply).
 *   - No idle queue / drain. We fire the instant we see the change. An agent
 *     that can't tolerate an interleaved notification shouldn't use perk.
 *   - No trigger types. Best-effort change detection from existence + mtime +
 *     size; we report what we saw, the agent decides what it means.
 *   - No canned message. The wake text is generated from id + path + the
 *     observed transition.
 *
 * What remains: register a path, fire a turn on change. Re-arm with ack.
 *
 * On top of that core, perk offers ONE convenience tool, perk_bash_background,
 * that runs a shell command as a detached fire-and-forget job and arms a
 * listener on the command's exit-code sentinel. It exists as a SEPARATE tool
 * (not a hook on the builtin bash) on purpose (issue #2): a bash hook had to
 * silently rewrite the agent's `command` into detach scaffolding, and that
 * rewritten command was what landed in the transcript. Since the transcript is
 * the agent's only memory, the agent would later read scaffolding it never
 * typed and conclude it had erred. A dedicated tool records exactly what the
 * agent typed; the scaffolding lives inside the tool implementation where it
 * belongs and never surfaces as a phantom edit to the agent's own words.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { statSync, appendFileSync, readFileSync, mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Sense organ: snapshot a path's existence + mtime + size.
//
// We compare {exists, mtimeMs, size} between polls. mtimeMs alone can miss a
// same-millisecond write; size catches content growth. Known POC gap: a
// same-mtime, same-size overwrite is invisible to stat. Acceptable here.
// ---------------------------------------------------------------------------

type Snapshot = { exists: boolean; mtimeMs: number; size: number }

function snapshot(path: string): Snapshot {
  try {
    const s = statSync(path)
    return { exists: true, mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 }
  }
}

// Best-effort description of the transition we observed, for the wake text.
// Returns null when nothing changed.
function describe(base: Snapshot, now: Snapshot): string | null {
  if (!base.exists && now.exists) return "appeared"
  if (base.exists && !now.exists) return "disappeared"
  if (base.exists && now.exists) {
    if (base.mtimeMs !== now.mtimeMs || base.size !== now.size) return "changed"
  }
  return null
}

// ---------------------------------------------------------------------------
// Listener state. Path + id + the baseline we compare against. Nothing else.
// ---------------------------------------------------------------------------

type Listener = {
  id: string
  path: string
  sessionID: string // which session to wake; captured from ToolContext
  armed: boolean // edge-trigger: false after firing, until ack re-arms
  baseline: Snapshot // the snapshot we compare against; reset on ack
  // Set when this listener watches a perk_bash_background job's exit-code file.
  // The exit file (= `path`) is ONE-SHOT: the job writes its exit code once and
  // is done, so re-arming is meaningless. Job listeners therefore AUTO-REMOVE
  // on fire (not disarm-and-await-ack), and the wake reports the exit code plus
  // the byte sizes of the captured stdout/stderr files (so the agent can decide
  // whether to read them). We never store or echo the command body: it can be
  // huge, and the agent already has it in its own tool call. perk generates all
  // three files (.exit/.out/.err) under the project .perk/ dir; the agent does
  // not choose or even see them until the wake.
  job?: { out: string; err: string }
}

const POLL_MS = 300

// ---------------------------------------------------------------------------
// Singleton shared state.
//
// CRITICAL FINDING: opencode may instantiate the plugin MORE THAN ONCE in a
// single server process. Each instantiation gets a fresh closure. Keep all
// mutable state in a single object hung off globalThis, shared by every
// instance. The plugin function only wires the live `client` into it and
// starts the one poll loop (guarded so it runs once).
// ---------------------------------------------------------------------------

type PerkState = {
  listeners: Map<string, Listener>
  nextId: number
  // The injector. Set by each plugin instance; latest live client wins. null
  // until at least one instance has loaded.
  inject: ((sessionID: string, message: string) => Promise<void>) | null
  pollStarted: boolean
  // perk_wait parks resolvers here. When a listener fires, the poll loop
  // injects the verdict FIRST (so the detail turn is enqueued before the
  // agent's turn ends), then resolves every parked waiter. Used only by
  // headless runs (opencode run) where ending a turn exits the process and the
  // out-of-band inject would otherwise arrive into nothing; see perk_wait.
  waiters: Set<() => void>
}

const GLOBAL_KEY = "__perk_state__"

function getState(): PerkState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      listeners: new Map(),
      nextId: 1,
      inject: null,
      pollStarted: false,
      waiters: new Set(),
    } satisfies PerkState
  }
  return g[GLOBAL_KEY] as PerkState
}

// Logging: NEVER write to stdout/stderr. When perk runs inside the opencode
// TUI, the renderer owns that surface and our writes corrupt the display.
// Append to a file instead. Opt out / redirect via PERK_LOG (set to "" or
// "off" to silence). Failures here are swallowed: logging must never break the
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
    // Collect everything that fired this tick, so we can inject all verdicts
    // BEFORE waking any parked perk_wait. The ordering matters in headless runs
    // (see PerkState.waiters): the verdict turn must be enqueued before the
    // agent's wait returns and its turn ends.
    const fired: { sessionID: string; message: string }[] = []
    const remove: string[] = [] // job listeners auto-removed after this tick
    for (const l of S.listeners.values()) {
      if (!l.armed) continue
      const now = snapshot(l.path)
      const what = describe(l.baseline, now)
      if (!what) continue
      l.armed = false // edge-trigger: stop re-firing this tick regardless
      l.baseline = now
      log("fired", { id: l.id, path: l.path, what, job: !!l.job })
      let message: string
      if (l.job) {
        // Backgrounded job: ONE-SHOT exit file holding the bare exit code. Read
        // the code, then mark this listener for removal: re-arming a finished
        // job makes no sense, and we do not want dead job listeners piling up
        // or being accidentally perk_ack'd back to life. Identify by id only;
        // never replay the (possibly huge) command body. Report the captured
        // stdout/stderr by path + byte size so the agent can decide what (if
        // anything) is worth reading.
        let code = "?"
        try {
          code = readFileSync(l.path, "utf8").trim() || "?"
        } catch {
          // exit file vanished or unreadable; report what we can
        }
        const verdict =
          code === "0"
            ? "exited cleanly (exit 0)"
            : code === "?"
              ? "finished (exit code unreadable)"
              : `exited with code ${code}`
        const outBytes = snapshot(l.job.out).size
        const errBytes = snapshot(l.job.err).size
        message =
          `[perk:${l.id}] background job ${verdict}. ` +
          `stdout: ${outBytes} bytes (${l.job.out}). ` +
          `stderr: ${errBytes} bytes (${l.job.err}). ` +
          `Read those files only if a size above suggests something useful. ` +
          `The job is done and this listener has been auto-removed (no ack ` +
          `needed). If you ran perk_wait, it has returned too; act on this.`
        remove.push(l.id)
      } else {
        message =
          `[perk:${l.id}] watched path ${l.path} ${what}. ` +
          `This listener is now disarmed; perk_ack ${l.id} to re-arm it, ` +
          `or perk_cancel ${l.id} to stop watching.`
      }
      fired.push({ sessionID: l.sessionID, message })
    }

    for (const id of remove) S.listeners.delete(id)

    if (fired.length === 0) return

    // Inject all verdicts, THEN release any parked perk_wait. We do not block
    // the poll tick on this; the ordering guarantee is only within this async
    // chain (inject awaited before resolve), which is all perk_wait relies on.
    void (async () => {
      if (S.inject) {
        for (const f of fired) {
          await S.inject(f.sessionID, f.message).catch((e) =>
            log("inject failed", { error: String(e) }),
          )
        }
      }
      if (S.waiters.size > 0) {
        const release = [...S.waiters]
        S.waiters.clear()
        log("waking perk_wait", { count: release.length })
        for (const resolve of release) resolve()
      }
    })()
  }, POLL_MS)
  if (typeof timer.unref === "function") timer.unref()
}

// Arm a listener and return its id. Shared by perk_register and
// perk_bash_background. `job` (the out/err capture paths) marks a one-shot job
// exit-code file: such listeners auto-remove on fire (see Listener.job) and
// report an exit code plus captured-output sizes.
function arm(
  S: PerkState,
  path: string,
  sessionID: string,
  job?: { out: string; err: string },
): string {
  const id = `perk_${S.nextId++}`
  const listener: Listener = {
    id,
    path,
    sessionID,
    armed: true,
    baseline: snapshot(path),
    job,
  }
  S.listeners.set(id, listener)
  log("registered", {
    id,
    path,
    sessionID,
    baselineExists: listener.baseline.exists,
    job: !!job,
  })
  return id
}

// Run a user command as a true fire-and-forget background job: the tool call
// returns immediately, the job survives this process's teardown, stdout/stderr
// are captured to files, and the command's bare exit code lands in the exit
// file (the one-shot completion sentinel the listener watches).
//
// Because perk_bash_background spawns the job ITSELF (from the plugin's Node
// process) rather than riding inside opencode's bash tool shell, detachment is
// handled by Node's spawn options, not by the nohup/disown/fd-severing dance a
// shared shell required (issue #2 retired the bash hook that needed those):
//
//   - detached: true        -> new session/process group; not killed when the
//                              parent (opencode) exits or its group is signalled.
//   - stdio: "ignore"       -> child holds no pipe back to us, so we never block
//                              on its output and there is nothing to drain.
//   - child.unref()         -> the parent's event loop does not wait on the child.
//
// The exit-code capture runs inside the shell command via a subshell so a bare
// `exit N` in the user's command ends only the job, $? is captured immediately,
// and the bare exit code is written LAST (after stdout/stderr files are closed),
// so when the listener sees the exit file appear, .out/.err are already complete.
function shSingleQuote(s: string): string {
  // Wrap s in single quotes, escaping embedded single quotes as '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Per-job private file set, generated by perk under the project .perk/ dir. The
// agent never names or sees these until the completion wake reports them. Using
// the project dir (not /tmp) avoids opencode's external-directory permission
// prompt that fires on any access outside the worktree.
type JobFiles = { base: string; exit: string; out: string; err: string }

function makeJobFiles(worktree: string, id: string): JobFiles {
  const dir = join(worktree, ".perk")
  mkdirSync(dir, { recursive: true })
  const base = join(dir, `${id}-${randomBytes(3).toString("hex")}`)
  return { base, exit: `${base}.exit`, out: `${base}.out`, err: `${base}.err` }
}

// Build the shell script the detached child runs. Run the user command in a
// SUBSHELL (so a bare `exit N` ends only the job), redirect its stdout/stderr to
// the capture files, then write the bare exit code to the exit file.
//
// NEWLINES, not semicolons, separate the parts. The user command can contain a
// trailing `#` comment, and a `#` runs to end-of-LINE; if `( <command> )` were
// one line, a comment would swallow the closing `)` and the redirect ("syntax
// error: unexpected end of file"). Putting the command on its own line between
// a lone `(` and `)` means any comment dies at the newline, and the closing
// paren + capture survive. The user command may itself be multi-line.
function backgroundScript(command: string, f: JobFiles): string {
  return [
    "(",
    command,
    `) >${shSingleQuote(f.out)} 2>${shSingleQuote(f.err)}`,
    `echo "$?" > ${shSingleQuote(f.exit)}`,
  ].join("\n")
}

// Spawn the detached job. Returns nothing; the listener (armed by the caller on
// the exit file) is what reports completion. cwd resolves relative paths in the
// user command.
function spawnBackground(command: string, f: JobFiles, cwd: string): void {
  const child = spawn("sh", ["-c", backgroundScript(command, f)], {
    cwd,
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

export const Perk: Plugin = async ({ client }) => {
  const S = getState()

  // Wire the live client into the shared injector. Every instance overwrites
  // with its own client; the most recently loaded (live) one wins.
  S.inject = async (sessionID, message) => {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text: message }] },
    })
  }

  startPoll(S)

  const hooks = {
    // The poll loop is a process-wide singleton (unref'd), shared across plugin
    // instances; we deliberately do NOT tear it down per-instance dispose.
    dispose: async () => {},

    tool: {
      perk_bash_background: tool({
        description:
          "Run a shell command as a detached, fire-and-forget background job " +
          "and get woken (via perk) when it finishes. This is NOT the builtin " +
          "bash: that one blocks until the command exits and hands you its " +
          "output; this one returns IMMEDIATELY (before the command finishes) " +
          "and instead arms a one-shot perk listener that hands you a turn on " +
          "completion with the exit-code verdict and the byte sizes + paths of " +
          "the captured stdout/stderr (then auto-removes itself: a finished job " +
          "needs no ack). Use it for long-running work you do not want to block " +
          "on (builds, downloads, test suites, agent runs). Give just the " +
          "command (e.g. 'make build' or 'sleep 20; exit 17'): you do NOT add " +
          "nohup/&/disown/redirection, choose any output paths, or write any " +
          "sentinel; perk handles detachment, captures stdout/stderr to files " +
          "under the project .perk/ dir, and records the exit code itself. What " +
          "lands in your transcript is exactly the command you typed. You get " +
          "the output-file paths back so you can read them later if needed; if " +
          "you want a PUBLIC rendezvous file for other observers, just write it " +
          "yourself inside the command (e.g. '... && touch shared.done'). " +
          "After calling: if a human is present (interactive session), end your " +
          "turn and go idle; perk wakes you on completion. If NO human is " +
          "present (you are running headless, e.g. via `opencode run`), do NOT " +
          "end your turn, because that exits the process and the wake arrives " +
          "into nothing: call perk_wait instead to block until the job finishes.",
        args: {
          command: tool.schema
            .string()
            .describe(
              "The shell command to run in the background (just the work, e.g. " +
                "'make build' or 'sleep 20; exit 17'). No nohup/&/disown/" +
                "redirection and no output paths to choose; perk adds " +
                "detachment and captures stdout/stderr to files for you. May be " +
                "multi-line and may contain # comments.",
            ),
        },
        async execute(args, ctx) {
          const f = makeJobFiles(ctx.directory, `job_${S.nextId}`)
          const id = arm(S, f.exit, ctx.sessionID, { out: f.out, err: f.err })
          spawnBackground(args.command, f, ctx.directory)
          log("perk_bash_background: spawned", {
            id,
            base: f.base,
            cwd: ctx.directory,
          })
          return (
            `Backgrounded as ${id} (running detached now). perk captures output ` +
            `for you: stdout -> ${f.out}, stderr -> ${f.err}, exit code -> ` +
            `${f.exit}. On completion perk wakes you with the exit code and the ` +
            `byte sizes of those files; the listener auto-removes then (no ack ` +
            `needed). If a human is present, end your turn now; do not poll. If ` +
            `you are running headless (no human to wake you), call perk_wait ` +
            `instead of ending your turn. (perk_cancel ${id} to drop the ` +
            `listener before it fires.)`
          )
        },
      }),

      perk_wait: tool({
        description:
          "Block the current turn until a perk event fires or a timeout " +
          "elapses, then return. This is the HEADLESS escape hatch: in a normal " +
          "interactive session you should NOT use it, because ending your turn " +
          "and going idle is strictly better (perk wakes you for free, with no " +
          "blocked turn and no wasted spend). But when NO human is present (you " +
          "are running via `opencode run` or similar), ending your turn exits " +
          "the process, so the out-of-band wake would arrive into nothing. " +
          "perk_wait keeps the turn alive so the wake can land. It returns a " +
          "bare 'awoken' (it does NOT carry the event details): the real wake " +
          "message, with the exit-code verdict or path transition, arrives as " +
          "the very next turn, exactly as in an interactive session. So on " +
          "return, just read the following turn. If there is nothing to wait for " +
          "(no armed listeners), it returns immediately. Use after " +
          "perk_bash_background (or perk_register) when running unattended.",
        args: {
          timeout_s: tool.schema
            .number()
            .optional()
            .describe(
              "Max seconds to block before giving up and returning 'timeout' " +
                "(default 300). A timeout is not an error: it just means no " +
                "watched path changed in time. Pick a value comfortably longer " +
                "than the job you expect to finish.",
            ),
        },
        async execute(args, _ctx) {
          const timeoutS = args.timeout_s ?? 300
          const anyArmed = () =>
            [...S.listeners.values()].some((l) => l.armed)
          log("perk_wait: entering", { timeoutS, anyArmed: anyArmed() })
          const woken = await new Promise<boolean | "empty">((resolve) => {
            let done = false
            const settle = (v: boolean | "empty") => {
              if (done) return
              done = true
              clearTimeout(t)
              S.waiters.delete(waiter)
              resolve(v)
            }
            const waiter = () => settle(true)
            const t = setTimeout(() => settle(false), timeoutS * 1000)
            if (typeof t.unref === "function") t.unref()
            // Register the waiter BEFORE the armed-state check to close the
            // check-then-wait race: if a listener fires between registering and
            // checking, the poll loop will release this waiter. After
            // registering, if nothing is armed, there is nothing to wait for
            // (or everything already fired), so settle at once.
            S.waiters.add(waiter)
            if (!anyArmed()) settle("empty")
          })
          if (woken === "empty") {
            log("perk_wait: nothing armed, returned immediately")
            return (
              "Nothing to wait for: no armed listeners. (Did the job already " +
              "finish and fire, or did you forget to arm one?) Returning at once."
            )
          }
          if (woken) {
            log("perk_wait: awoken by event")
            return (
              "Awoken by a perk event. The wake message (with the verdict / " +
              "transition) is the next turn; read it now and act on it."
            )
          }
          log("perk_wait: timed out", { timeoutS })
          return (
            `Timed out after ${timeoutS}s with no perk event. None of the ` +
            `watched paths changed in that window. You can perk_wait again, ` +
            `check the sentinel directly, or give up.`
          )
        },
      }),

      perk_register: tool({
        description:
          "Watch a filesystem path. The next time the path changes (appears, " +
          "disappears, or its contents change), you receive a turn saying so. " +
          "Edge-triggered: fires once, then disarms until you perk_ack it. " +
          "Returns the listener id.",
        args: {
          path: tool.schema
            .string()
            .describe(
              "Path to watch (e.g. .perk/job.done or an absolute path). Prefer " +
                "a path inside the project dir: opencode prompts for permission " +
                "on any access outside the worktree.",
            ),
        },
        async execute(args, ctx) {
          const id = arm(S, args.path, ctx.sessionID)
          return `watching ${args.path} as ${id} (re-arm with perk_ack, stop with perk_cancel)`
        },
      }),

      perk_ack: tool({
        description:
          "Re-arm a listener that has fired. Takes a fresh baseline snapshot " +
          "so the next change fires again.",
        args: {
          id: tool.schema.string().describe("Listener id from perk_register."),
        },
        async execute(args, _ctx) {
          const l = S.listeners.get(args.id)
          if (!l) return `no such listener: ${args.id}`
          l.armed = true
          l.baseline = snapshot(l.path)
          log("acked (re-armed)", { id: l.id, baselineExists: l.baseline.exists })
          return `re-armed ${l.id} watching ${l.path}`
        },
      }),

      perk_cancel: tool({
        description: "Stop watching: remove a listener entirely.",
        args: {
          id: tool.schema.string().describe("Listener id from perk_register."),
        },
        async execute(args, _ctx) {
          const existed = S.listeners.delete(args.id)
          log("cancelled", { id: args.id, existed })
          return existed ? `cancelled ${args.id}` : `no such listener: ${args.id}`
        },
      }),
    },
  }

  return hooks as any
}

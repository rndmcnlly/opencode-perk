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
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { statSync, appendFileSync, readFileSync } from "node:fs"

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
  // When set, this listener was armed by a backgrounded bash job (perk arg).
  // On fire we read the sentinel's contents (the bare exit code) and report it,
  // and we phrase the wake as a job completion rather than a generic change.
  job?: { command: string }
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
  // Correlates a backgrounded bash call between the before/after hooks, keyed
  // by the tool callID. Holds the perk listener id and chosen sentinel path.
  jobByCall: Map<string, { id: string; sentinel: string }>
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
      jobByCall: new Map(),
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
    for (const l of S.listeners.values()) {
      if (!l.armed) continue
      const now = snapshot(l.path)
      const what = describe(l.baseline, now)
      if (what) {
        // Edge-trigger: fire once, then disarm. ack re-arms.
        l.armed = false
        l.baseline = now // so an immediate ack re-baselines from here
        log("fired", { id: l.id, path: l.path, what })
        let message: string
        if (l.job) {
          // Backgrounded bash job: the sentinel holds the bare exit code.
          let code = "?"
          try {
            code = readFileSync(l.path, "utf8").trim() || "?"
          } catch {
            // sentinel vanished or unreadable; report what we can
          }
          const verdict =
            code === "0"
              ? "exited cleanly (0)"
              : code === "?"
                ? "finished (exit code unreadable)"
                : `exited with code ${code}`
          message =
            `[perk:${l.id}] background command ${verdict}: ${l.job.command}. ` +
            `Sentinel ${l.path} (perk_cancel ${l.id} to drop the listener).`
        } else {
          message =
            `[perk:${l.id}] watched path ${l.path} ${what}. ` +
            `This listener is now disarmed; perk_ack ${l.id} to re-arm it, ` +
            `or perk_cancel ${l.id} to stop watching.`
        }
        if (S.inject) {
          void S.inject(l.sessionID, message).catch((e) =>
            log("inject failed", { id: l.id, error: String(e) }),
          )
        }
      }
    }
  }, POLL_MS)
  if (typeof timer.unref === "function") timer.unref()
}

// Arm a listener and return its id. Shared by perk_register and the perk-arg
// bash augmentation. `job` marks listeners spawned by a backgrounded command.
function arm(
  S: PerkState,
  path: string,
  sessionID: string,
  job?: { command: string },
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

// Wrap a user command so it runs as a true fire-and-forget background job: the
// tool call returns immediately, the job survives the tool shell's teardown,
// output is discarded, and the command's bare exit code lands in `sentinel`.
//
// Two independent properties are required, and BOTH were established empirically
// (FEEDBACK2): returning fast and surviving teardown are NOT the same thing.
//
//   1. Return immediately. opencode's bash tool returns on stdout/stderr pipe
//      EOF, not on foreground-process exit. A backgrounded child that inherits
//      the tool's fds holds the pipe open, so the call blocks for the job's full
//      duration. We sever ALL THREE fds (>/dev/null 2>&1 </dev/null) so the pipe
//      hits EOF at once. (stdin matters too: an inherited stdin keeps it open.)
//
//   2. Survive teardown. When the tool's shell exits it can SIGHUP / reap its
//      children. `setsid` returns fast but its child was KILLED during teardown
//      in this environment; only `nohup ... &` + `disown` survived. `nohup`
//      ignores SIGHUP; `disown` drops the job from the shell's job table.
//
// The exit-code capture runs INSIDE the detached `sh -c`, before its own fds are
// severed, so the sentinel write still happens. Portable across the zsh/bash the
// opencode tool shell uses (disown is a zsh/bash builtin, present on macOS/Linux/
// WSL; not POSIX sh, hence the outer shell, not the inner `sh -c`, runs it).
function shSingleQuote(s: string): string {
  // Wrap s in single quotes, escaping embedded single quotes as '\''.
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function wrapBackgrounded(command: string, sentinel: string): string {
  // Inner script (runs detached under `sh -c`): run the user command in a
  // SUBSHELL so a bare `exit N` ends only the job, capture $? immediately, and
  // write the bare exit code to the sentinel. The sentinel path is single-quoted
  // here for the inner sh.
  const inner = `( ${command} ) >/dev/null 2>&1; echo "$?" > ${shSingleQuote(sentinel)}`
  // Outer: detach the inner script via nohup + disown with all three fds severed
  // from the tool's pipe. The inner script is single-quoted (one more layer of
  // escaping) as the argument to `sh -c`.
  return `nohup sh -c ${shSingleQuote(inner)} >/dev/null 2>&1 </dev/null & disown`
}

export const Perk: Plugin = async ({ client }) => {
  const S = getState()
  const jobByCall = S.jobByCall

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

    // --- bash augmentation: an optional `perk` arg turns any bash invocation
    // into a fire-and-forget background job whose exit code lands in the named
    // sentinel path. The path is caller-chosen so the completion file is a
    // public rendezvous point other tools/agents/humans can also wait on.

    // 1. Advertise the extra arg on the builtin bash tool's schema.
    "tool.definition": async (
      input: { toolID: string },
      output: { description: string; parameters: any },
    ) => {
      if (input.toolID !== "bash") return
      const p = output.parameters
      // JSON Schema object: add an optional string property. Leave it out of
      // `required` so existing calls are unaffected.
      if (p && p.type === "object" && p.properties) {
        p.properties.perk = {
          type: "string",
          description:
            "Run this command as a fire-and-forget background job; wake the " +
            "session when it finishes. The value is the sentinel path (you " +
            "choose it on purpose so other observers can wait on the same file). " +
            "Give a PLAIN command (e.g. 'sleep 20; exit 17'): just the work, no " +
            "nohup/&/disown/redirection and no sentinel write of your own. perk " +
            "supplies all of that for you. " +
            "EXPECT YOUR HISTORY TO BE REWRITTEN: perk replaces your `command` " +
            "with detach scaffolding (nohup/subshell/redirection + the exit-code " +
            "write) BEFORE it runs, and that rewritten command is what gets " +
            "recorded in the transcript. So when you look back you will see a " +
            "command you did not type sitting in your own tool call. That is the " +
            "plugin rewriting history, not a mistake of yours: do not 'correct' " +
            "it or hand-roll the scaffolding to match. The tool returns " +
            "immediately with a 'Backgrounded as perk_N' notice (text perk adds, " +
            "NOT your command's output), and a listener wakes you on completion " +
            "with the exit-code verdict. stdout/stderr are discarded, so log " +
            "inside the command body if you need output. Pick a fresh, absolute " +
            "path that does not yet exist (e.g. /tmp/job-7.done).",
        }
      }
      output.description +=
        "\n\nBackgrounding (`perk` arg): set `perk` to a fresh filesystem path " +
        "to run the command as a detached fire-and-forget job and be woken (via " +
        "perk) with its exit code when it finishes. The call returns immediately. " +
        "Pass a plain command (just the work); perk supplies the detach " +
        "scaffolding and the sentinel write. Note: perk rewrites your `command` " +
        "into that scaffolding before it runs, and the REWRITTEN command is what " +
        "appears in your transcript, so you will later see a command you did not " +
        "type in your own tool call. That is expected; do not correct it. " +
        "Without `perk`, the command runs verbatim as usual."
    },

    // 2. Rewrite the command + arm the listener, before the builtin runs.
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any },
    ) => {
      if (input.tool !== "bash") return
      try {
        const a = output.args
        const sentinel: unknown = a?.perk
        if (typeof sentinel !== "string" || sentinel.length === 0) {
          log("before: no perk arg", { callID: input.callID, hasArgs: !!a })
          return
        }
        const original: string = a.command
        const id = arm(S, sentinel, input.sessionID, { command: original })
        jobByCall.set(input.callID, { id, sentinel })
        a.command = wrapBackgrounded(original, sentinel)
        delete a.perk // the builtin tool's schema validation must not see it
        log("before: backgrounded", { callID: input.callID, id, sentinel })
      } catch (e) {
        // Never let an augmentation failure crash the tool pipeline. Log loudly;
        // the call will fall through to a normal (un-backgrounded) bash run.
        log("before: ERROR", { callID: input.callID, error: String(e) })
      }
    },

    // 3. Rewrite the (now near-instant, empty) return into a useful notice.
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any },
    ) => {
      if (input.tool !== "bash") return
      try {
        const job = jobByCall.get(input.callID)
        if (!job) {
          log("after: no job for callID", { callID: input.callID })
          return
        }
        jobByCall.delete(input.callID)
        output.output =
          `[perk] Backgrounded as ${job.id}. The command shown in this tool ` +
          `call is NOT what you typed: perk rewrote your command into detach ` +
          `scaffolding before running it, and that rewritten form is what your ` +
          `transcript now records. This is expected, not your doing; leave it ` +
          `as-is. It is running detached now; its bare exit code will be written ` +
          `to ${job.sentinel} on completion, and perk will wake you then with ` +
          `the verdict. Stop here; do not poll. (perk_cancel ${job.id} to drop ` +
          `the listener.)`
        log("after: notice emitted", { callID: input.callID, id: job.id })
      } catch (e) {
        log("after: ERROR", { callID: input.callID, error: String(e) })
      }
    },

    tool: {
      perk_register: tool({
        description:
          "Watch a filesystem path. The next time the path changes (appears, " +
          "disappears, or its contents change), you receive a turn saying so. " +
          "Edge-triggered: fires once, then disarms until you perk_ack it. " +
          "Returns the listener id.",
        args: {
          path: tool.schema
            .string()
            .describe("Absolute path to watch (e.g. /tmp/job-42.done)."),
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

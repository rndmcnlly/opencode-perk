/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * The model registers interest in a filesystem path; when that path changes,
 * perk injects a conversational turn describing the change. That's the whole
 * product.
 *
 * One code path: a stat-poll loop. The native file watcher cannot see
 * arbitrary absolute paths like /tmp (it watches only the project dir and
 * hardcodes **/tmp/** in its ignore list), so perk owns its sense organ.
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
import { statSync, appendFileSync } from "node:fs"

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
        const message =
          `[perk:${l.id}] watched path ${l.path} ${what}. ` +
          `This listener is now disarmed; perk_ack ${l.id} to re-arm it, ` +
          `or perk_cancel ${l.id} to stop watching.`
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
          const id = `perk_${S.nextId++}`
          const listener: Listener = {
            id,
            path: args.path,
            sessionID: ctx.sessionID,
            armed: true,
            baseline: snapshot(args.path),
          }
          S.listeners.set(id, listener)
          log("registered", {
            id,
            path: args.path,
            sessionID: ctx.sessionID,
            baselineExists: listener.baseline.exists,
          })
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

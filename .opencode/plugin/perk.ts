/**
 * perk: a minimal afferent channel for a harnessed model.
 *
 * The model registers interest in a filesystem path; when that path changes,
 * perk injects a conversational turn (the model's own note-to-future-self),
 * gated on the session being idle so turns are never torn.
 *
 * One code path: a stat-poll loop. The native file watcher cannot see
 * arbitrary absolute paths like /tmp (verified, see RESEARCH.md), so perk
 * owns its sense organ.
 *
 * Design commitments (from README, do not drift):
 *   1. Maximally generic: observe a path, fire a turn on change. No workflows.
 *   2. Build only on what exists: filesystem is the substrate.
 *   3. Edge-triggered with explicit re-arming: fire once, then disarm; ack to re-arm.
 *   4. Turns are serialized, never torn: gate injection on session.idle.
 *   5. Stay a plugin: rides client.session.promptAsync + the session.idle event.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { statSync, appendFileSync } from "node:fs"

// ---------------------------------------------------------------------------
// Sense organ: snapshot a path's existence + mtime + size.
//
// We compare {exists, mtimeMs, size} between polls. mtimeMs alone can miss a
// same-millisecond write; size catches content growth. Known POC gap: a
// same-mtime, same-size overwrite is invisible to stat (a content hash would
// close it, at the cost of reading the file every poll). Acceptable here.
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

type Trigger = "create" | "change" | "delete"

/**
 * Decide whether a transition from `base` to `now` matches the configured
 * trigger. Baseline semantics (settled in README commitment 3): we fire only on
 * a *transition away from the baseline snapshot taken at register/ack time*.
 *
 *   create: absent -> present.   A path that already exists at register time
 *           does NOT fire until it goes absent and returns.
 *   delete: present -> absent.
 *   change: present -> present with different mtime or size.
 */
function matches(on: Trigger, base: Snapshot, now: Snapshot): boolean {
  switch (on) {
    case "create":
      return !base.exists && now.exists
    case "delete":
      return base.exists && !now.exists
    case "change":
      return (
        base.exists &&
        now.exists &&
        (base.mtimeMs !== now.mtimeMs || base.size !== now.size)
      )
  }
}

// ---------------------------------------------------------------------------
// Listener state. One Map, in-process, for the life of the plugin instance.
// ---------------------------------------------------------------------------

type Listener = {
  id: string
  path: string
  on: Trigger
  message: string
  reply: boolean // false => inject context-only (noReply), no model turn
  sessionID: string // which session to wake; captured from ToolContext
  armed: boolean // edge-trigger: false after firing, until ack re-arms
  baseline: Snapshot // the snapshot we compare against; reset on ack
  triggerCount: number
  lastFired: number | null // epoch ms
}

const POLL_MS = 300

// ---------------------------------------------------------------------------
// Singleton shared state.
//
// CRITICAL FINDING (verified, see RESEARCH.md note 5): opencode may instantiate
// the plugin MORE THAN ONCE in a single server process (observed: the function
// body and "loading plugin" ran twice). Each instantiation gets a fresh closure.
// If listeners/mailboxes/idle live in that closure, a tool call (enqueue) and
// the event hook (drain) can land in DIFFERENT instances and never see each
// other's state: a queued wake is stranded.
//
// Fix: keep all mutable state in a single object hung off globalThis, shared by
// every instance. The plugin function only wires the live `client` into it and
// starts the one poll loop (guarded so it runs once).
// ---------------------------------------------------------------------------

type Wake = { message: string; reply: boolean }

type PerkState = {
  listeners: Map<string, Listener>
  idleSessions: Set<string>
  mailboxes: Map<string, Wake[]>
  drainInFlight: Set<string>
  nextId: number
  // The injector. Set by each plugin instance; latest live client wins. null
  // until at least one instance has loaded.
  inject:
    | ((sessionID: string, wake: Wake) => Promise<void>)
    | null
  pollStarted: boolean
}

const GLOBAL_KEY = "__perk_state__"

function getState(): PerkState {
  const g = globalThis as Record<string, unknown>
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      listeners: new Map(),
      idleSessions: new Set(),
      mailboxes: new Map(),
      drainInFlight: new Set(),
      nextId: 1,
      inject: null,
      pollStarted: false,
    } satisfies PerkState
  }
  return g[GLOBAL_KEY] as PerkState
}

// Logging: NEVER write to stdout/stderr. When perk runs inside the opencode
// TUI, the renderer owns that surface and our writes corrupt the display
// (observed in a trial run). Append to a file instead. Opt out / redirect via
// PERK_LOG (set to "" or "off" to silence). Failures here are swallowed:
// logging must never break the channel.
const LOG_PATH =
  process.env.PERK_LOG === undefined ? "/tmp/perk.log" : process.env.PERK_LOG
const log = (...a: unknown[]) => {
  if (!LOG_PATH || LOG_PATH === "off") return
  try {
    const line = a
      .map((x) =>
        typeof x === "string" ? x : JSON.stringify(x),
      )
      .join(" ")
    appendFileSync(LOG_PATH, `${new Date().toISOString()} [perk] ${line}\n`)
  } catch {
    // never let logging break the channel
  }
}

function enqueue(S: PerkState, sessionID: string, wake: Wake) {
  const box = S.mailboxes.get(sessionID) ?? []
  box.push(wake)
  S.mailboxes.set(sessionID, box)
}

async function drain(S: PerkState, sessionID: string) {
  // Inject at most ONE queued wake per call, then stop. A reply wake makes the
  // session busy, so the next wake waits for the following session.idle (which
  // re-invokes us). A noReply wake runs no turn and emits no idle, so on success
  // we self-reschedule to keep a context-only backlog moving. Either way:
  // strictly one per tick, FIFO.
  //
  // Ownership of idleSessions belongs to the event handler (idle adds, busy
  // removes). We only optimistically clear it after a successful reply-inject
  // to close the gap before the busy event lands.
  if (!S.inject) return
  if (S.drainInFlight.has(sessionID)) return // re-entrancy guard
  if (!S.idleSessions.has(sessionID)) return
  const box = S.mailboxes.get(sessionID)
  if (!box || box.length === 0) return

  const wake = box[0] // peek; remove only after a successful send
  S.drainInFlight.add(sessionID)
  try {
    await S.inject(sessionID, wake)
    box.shift() // committed
    if (wake.reply) S.idleSessions.delete(sessionID)
    log("injected wake", {
      sessionID,
      reply: wake.reply,
      remaining: box.length,
    })
    // A reply wake will make the session busy; the resulting session.idle
    // re-invokes drain to flush the next item. A noReply wake runs no turn, so
    // it produces no idle event: nothing would re-invoke us. If the session is
    // still idle and items remain, self-reschedule so a backlog of context-only
    // notes keeps draining (still one per tick, FIFO).
    if (!wake.reply && box.length > 0) {
      setTimeout(() => void drain(S, sessionID), 0)
    }
  } catch (e) {
    log("promptAsync failed; leaving queued", { sessionID, error: String(e) })
  } finally {
    S.drainInFlight.delete(sessionID)
  }
}

function startPoll(S: PerkState) {
  if (S.pollStarted) return
  S.pollStarted = true
  const timer = setInterval(() => {
    for (const l of S.listeners.values()) {
      if (!l.armed) continue
      const now = snapshot(l.path)
      if (matches(l.on, l.baseline, now)) {
        // Edge-trigger: fire once, then disarm. ack re-arms.
        l.armed = false
        l.triggerCount += 1
        l.lastFired = Date.now()
        l.baseline = now // so an immediate ack re-baselines from here
        log("fired", { id: l.id, path: l.path, on: l.on })
        enqueue(S, l.sessionID, { message: l.message, reply: l.reply })
        void drain(S, l.sessionID)
      } else {
        // Keep the baseline current for non-matching changes so a stale
        // baseline cannot manufacture a phantom edge later.
        //
        // create: we are waiting for an absent->present edge. If the file is
        // currently absent, advance the baseline INTO that absence so a later
        // return registers as a real edge. (Previously we only advanced when
        // present, which erased a transient absence and made an acked
        // create-listener unable to ever fire on absent->present.) When
        // present and non-matching, the baseline is already present; leave it.
        if (l.on === "change") l.baseline = now
        if (l.on === "create" && !now.exists) l.baseline = now
        if (l.on === "delete" && !now.exists) l.baseline = now
      }
    }
  }, POLL_MS)
  if (typeof timer.unref === "function") timer.unref()
}

export const Perk: Plugin = async ({ client }) => {
  const S = getState()

  // Wire the live client into the shared injector. Every instance overwrites
  // with its own client; the most recently loaded (live) one wins, which is
  // what we want since stale clients may be disposed.
  S.inject = async (sessionID, wake) => {
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        noReply: wake.reply ? undefined : true,
        parts: [{ type: "text", text: wake.message }],
      },
    })
  }

  startPoll(S)


  // -------------------------------------------------------------------------
  // Idle tracking via the event hook. session.idle => session is drainable.
  // session.status {busy} => session is mid-turn, hold off.
  // -------------------------------------------------------------------------

  const hooks = {
    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      if (event.type === "session.idle") {
        const sid = event.properties?.sessionID
        if (typeof sid === "string") {
          S.idleSessions.add(sid)
          void drain(S, sid)
        }
      } else if (event.type === "session.status") {
        const sid = event.properties?.sessionID
        const status = event.properties?.status
        // Treat any busy status as "not drainable". Other statuses settle to
        // idle, which session.idle reports separately.
        if (typeof sid === "string" && status && status.type === "busy") {
          S.idleSessions.delete(sid)
        }
      }
    },

    // The poll loop is a process-wide singleton (unref'd), shared across plugin
    // instances; we deliberately do NOT tear it down per-instance dispose.
    dispose: async () => {},

    tool: {
      perk_register: tool({
        description:
          "Arm a listener on a filesystem path. When the path changes in the " +
          "configured way, you receive `message` as a new turn (gated on idle). " +
          "Edge-triggered: fires once, then disarms until you perk_ack it. " +
          "Baseline is snapshotted now: `create` fires only on a fresh " +
          "absent->present transition, not if the path already exists.",
        args: {
          path: tool.schema
            .string()
            .describe("Absolute path to observe (e.g. /tmp/job-42.done)."),
          on: tool.schema
            .enum(["create", "change", "delete"])
            .describe("Which transition to fire on."),
          message: tool.schema
            .string()
            .describe(
              "The turn you will receive when it fires: a note-to-future-self.",
            ),
          reply: tool.schema
            .boolean()
            .optional()
            .describe(
              "Default true: the wake is a real turn you respond to. " +
                "Set false to inject context-only (noReply), no model turn.",
            ),
        },
        async execute(args, ctx) {
          const id = `perk_${S.nextId++}`
          const listener: Listener = {
            id,
            path: args.path,
            on: args.on,
            message: args.message,
            reply: args.reply ?? true,
            sessionID: ctx.sessionID,
            armed: true,
            baseline: snapshot(args.path),
            triggerCount: 0,
            lastFired: null,
          }
          S.listeners.set(id, listener)
          log("registered", {
            id,
            path: args.path,
            on: args.on,
            sessionID: ctx.sessionID,
            baselineExists: listener.baseline.exists,
          })
          return JSON.stringify(
            {
              id,
              path: args.path,
              on: args.on,
              armed: true,
              baselineExists: listener.baseline.exists,
            },
            null,
            2,
          )
        },
      }),

      perk_list: tool({
        description:
          "List active listeners with trigger stats and armed state. Check " +
          "this to notice listeners that have fired and are waiting on you to " +
          "perk_ack them (status \"fired-needs-ack\"): a disarmed listener will " +
          "not fire again until acked.",
        args: {},
        async execute(_args, _ctx) {
          const rows = [...S.listeners.values()].map((l) => {
            // Derived state, so an agent does not have to infer "disarmed +
            // has-fired => needs ack" from the raw fields. A fired listener
            // stays silent until acked; surface that as a first-class flag.
            const needsAck = !l.armed && l.triggerCount > 0
            const status = needsAck
              ? "fired-needs-ack"
              : l.armed
                ? "armed"
                : "disarmed"
            return {
              id: l.id,
              path: l.path,
              on: l.on,
              armed: l.armed,
              status,
              needsAck,
              reply: l.reply,
              triggerCount: l.triggerCount,
              lastFired: l.lastFired,
              sessionID: l.sessionID,
            }
          })
          const pending = rows.filter((r) => r.needsAck).length
          return JSON.stringify(
            { pendingAck: pending, listeners: rows },
            null,
            2,
          )
        },
      }),

      perk_ack: tool({
        description:
          "Re-arm a listener that has fired. Takes a fresh baseline snapshot " +
          "so the next matching transition fires again.",
        args: {
          id: tool.schema.string().describe("Listener id from perk_register."),
        },
        async execute(args, _ctx) {
          const l = S.listeners.get(args.id)
          if (!l) return `no such listener: ${args.id}`
          l.armed = true
          l.baseline = snapshot(l.path)
          log("acked (re-armed)", { id: l.id, baselineExists: l.baseline.exists })
          return JSON.stringify(
            { id: l.id, armed: true, baselineExists: l.baseline.exists },
            null,
            2,
          )
        },
      }),

      perk_cancel: tool({
        description: "Remove a listener entirely.",
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

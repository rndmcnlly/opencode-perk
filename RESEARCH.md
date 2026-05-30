# perk: research findings

Status: primitives verified hands-on against opencode **1.15.12** on darwin
(Apple Silicon). This document is the handoff for a fresh session that will
write `.opencode/plugin/perk.ts`. Read it with the README; the README owns the
*why* and the design commitments, this owns the *verified how*.

Everything below was confirmed by running a headless server with a probe
plugin and driving it over HTTP, not by reading types alone. Citations point
at the installed SDK/plugin type sources (ground truth, generated from the
server OpenAPI spec) so a fresh session can re-verify if the API drifts.

---

## TL;DR for the implementer

1. The plugin lives at `.opencode/plugin/perk.ts`. **Auto-discovered, no config
   entry needed.** Verified: it appeared in `/config`'s `plugin` list on its own.
2. Inject wake turns with **`client.session.promptAsync`** (HTTP route
   `POST /session/{id}/prompt_async`). It is fire-and-forget: returns an empty
   body immediately, then the turn runs in the background. Verified end to end
   (injected turn produced a real assistant reply).
3. Gate injection on **`session.idle`** delivered through the `event` hook.
   Verified: fires reliably after each turn settles (even an errored one).
4. **The native file watcher cannot see `/tmp` or arbitrary absolute paths, and
   its ignore list contains `**/tmp/**`.** perk MUST bring its own watcher.
   Decision (settled with the user): a **stat-poll** loop over registered
   absolute paths. Verified: clean create/change/delete detection on `/tmp`
   using `mtimeMs` + `size`.
5. The native `file.watcher.updated` event is therefore **not used** by perk's
   core. One code path, not two.

---

## Verified primitives (with citations)

Installed sources (read these, do not trust docs that "may drift"):

- Plugin types: `~/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts`
- Tool helper: `~/.opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts`
- SDK types: `~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
- SDK methods: `~/.opencode/node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts`

### Plugin module shape

`Plugin = (input: PluginInput, options?) => Promise<Hooks>`
(`index.d.ts:51`). `PluginInput` delivers `{ client, project, directory,
worktree, serverUrl, $, ... }` (`index.d.ts:36-46`).

Verified at load (probe printed): `directory = /Users/adam/Desktop/perk`,
`worktree = /` (root, because this dir is not yet a git repo: see git note
below). The plugin loads **lazily on first session creation**, not at server
boot. Plan for that: the watcher loop and idle-mailbox must be set up inside the
plugin function body, which runs once when first instantiated.

### Hooks we use

`Hooks` (`index.d.ts:170-313`):

- `event?: (input: { event: Event }) => Promise<void>` (`index.d.ts:171-173`).
  This is how we receive `session.idle`. Verified firing.
- `tool?: { [key: string]: ToolDefinition }` (`index.d.ts:175-177`). This is how
  the four `perk_*` tools register. Verified the probe tool registered.

### Tool definition shape

`tool({ description, args, execute(args, ctx) })` (`tool.d.ts:40-48`).
`args` is a **Zod raw shape**; use `tool.schema` (re-exported zod) for the
field schemas (`tool.d.ts:49-51`). `execute` returns
`string | { output: string, metadata?: {...} }` (`tool.d.ts:34-39`).

`ToolContext` (`tool.d.ts:3-25`) hands `execute` the crucial
**`sessionID`** plus `messageID`, `agent`, `directory`, `worktree`, `abort`.
**This is where perk captures which session to wake.** Verified: probe logged
the live `sessionID` on call.

### Injecting a turn: `promptAsync`

`client.session.promptAsync` (`sdk.gen.d.ts:179-182`, doc string: "Create and
send a new message to a session, start if needed and return immediately").
Body shape `SessionPromptAsyncData.body` (`types.gen.d.ts:2326-2351`):

```jsonc
{
  "model": { "providerID": "...", "modelID": "..." }, // optional; omit to use session default
  "agent": "...",            // optional
  "noReply": true,           // optional: inject context WITHOUT a model response
  "system": "...",           // optional
  "parts": [ { "type": "text", "text": "the wake message" } ]  // required
}
```

`TextPartInput` (`types.gen.d.ts:1231-1244`): `{ type: "text", text: string }`
is the minimal valid part.

Verified end to end over HTTP:

```bash
curl -s -X POST "http://127.0.0.1:PORT/session/$SID/prompt_async" \
  -H 'content-type: application/json' \
  -d '{ "model": {"providerID":"omlx","modelID":"Qwen3.6-35B-A3B-8bit"},
        "parts": [{"type":"text","text":"WAKE TEST. Reply with exactly: PERK-OK"}] }'
# -> empty body, immediate return; assistant later replied "PERK-OK"
```

Note: the *route* is `prompt_async` (underscore). The SDK *method* is
`promptAsync` (camelCase). There is also a synchronous `prompt`
(`sdk.gen.d.ts:174`) that resolves only when the assistant finishes; do NOT use
it from the watcher loop, it would block. `promptAsync` is the correct injector.

`noReply: true` exists on both `prompt` and `promptAsync` bodies
(`types.gen.d.ts:2249`, `:2334`) for context-only injection. Not exercised in the
probe; flagged for the implementer if a "note without a reply" mode is wanted.

### The gating signal: `session.idle`

`EventSessionIdle = { type: "session.idle", properties: { sessionID } }`
(`types.gen.d.ts:413-418`). Verified: the probe's `event` hook logged
`session.idle {"sessionID":"ses_..."}` after each turn settled, including after
an errored turn. Also present on the raw SSE stream (`GET /event`).

`EventFileWatcherUpdated = { type: "file.watcher.updated", properties: { file,
event: "add"|"change"|"unlink" } }` (`types.gen.d.ts:525-531`). Documented for
completeness; **perk does not consume it** (see watcher finding).

### Event list (live, observed on the SSE stream)

`server.connected`, `session.created`, `session.updated`, `session.status`
(`{type:"busy"}` / settles), `message.updated`, `message.part.updated`,
`session.idle`, `session.error`, `session.diff`, `server.heartbeat`,
`session.next.agent.switched`, `session.next.model.switched`. Full union type at
`types.gen.d.ts:602`.

---

## The settled empirical question: native watcher scope

**Question (from README): can the built-in file watcher observe arbitrary paths
like `/tmp`?**

**Answer: No.** Read directly from the binary's embedded watcher service
(`FileWatcher` effect, minified symbol `g1`). The native watcher only ever
subscribes to two roots:

1. The project `directory` itself, and **only** when the env var
   `OPENCODE_EXPERIMENTAL_FILEWATCHER` is set (it is off by default).
2. The `.git` directory (for VCS branch tracking), when the project is a git repo.

There is no mechanism to register an arbitrary absolute path. Worse, the
watcher's hardcoded ignore patterns (`IR`) include `**/tmp/**` and `**/temp/**`,
so even an in-tree `tmp/` would be filtered. The backend is `fs-events` on
darwin via a native binding.

Relevant env vars (confirmed in binary + config schema):

- `OPENCODE_EXPERIMENTAL_FILEWATCHER` gates whether the project dir is watched.
- `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER` disables the service entirely.
- `watcher.ignore` in `opencode.json` (the `watcher` config key exists:
  `{ ignore?: string[] }`) appends to the ignore list.

**Consequence for perk:** the README's motivating example
(`sleep 300 && touch /tmp/wake`, then perk on `/tmp/wake`) is impossible on the
native watcher. perk owns its sense organ with a stat-poll. This is the
"own-watch fallback" the README anticipated, promoted to the primary (and only)
path because the user chose `/tmp` as the canonical watch target.

### Stat-poll verified

A standalone Bun probe polling `/tmp/perk-poll-target` every 200ms, comparing
`{ exists, mtimeMs, size }` snapshots, cleanly detected `change` (twice) and
`delete`. `mtimeMs` gives millisecond resolution (observed 211463 -> 211972).

**Design notes surfaced by the probe (genuine spec decisions, not plumbing):**

- Use `mtimeMs` AND `size` for the change signal. mtime alone can miss
  same-millisecond writes; size catches content growth. (Even both can miss a
  same-mtime same-size overwrite; acceptable for the POC, note it.)
- **The "already exists at register time" case is a real semantic choice.**
  When `perk_register({ path, on: "create" })` is called and the path already
  exists, does it fire immediately or only on a fresh absence->presence
  transition? The README's edge-trigger language implies: take a baseline
  snapshot at register time and fire only on a *transition* from it. Decide and
  document this.
- Poll interval: 200ms felt instant in the probe. A 250-500ms default is a fine
  POC choice; do not expose a knob yet (keep zero-config).

---

## Architecture for the implementation

Single file `.opencode/plugin/perk.ts`. The plugin function runs once (lazily,
on first session). Inside it:

- **In-process state**: `Map<id, Listener>` where a `Listener` holds
  `{ id, path, on: "create"|"change"|"delete", message, sessionID, armed,
  baselineSnapshot, triggerCount, lastFired }`. `sessionID` is captured from
  `ToolContext` at register time.
- **One stat-poll loop** (`setInterval`), iterating armed listeners, comparing
  current snapshot to baseline, detecting the configured transition.
- **Idle tracking**: the `event` hook records per-session idle state from
  `session.idle`. Maintain a set of idle session ids (and clear on
  `session.status {busy}` / message activity).
- **One mailbox, delivered in order** (README commitment 4). When a listener
  fires: enqueue its wake message for its `sessionID`; only `promptAsync` it
  when that session is idle; otherwise leave queued. After firing, **disarm**
  the listener (edge-trigger, commitment 3). Never inject mid-turn.
- **Four tools**: `perk_register`, `perk_list`, `perk_ack` (re-arm), `perk_cancel`.

### Tool surface (from README sketch; finalize signatures)

- `perk_register({ path, on, message })` -> returns `{ id }`. Captures
  `ctx.sessionID`. Takes baseline snapshot now.
- `perk_list()` -> listeners with `triggerCount`, `lastFired`, `armed`.
- `perk_ack({ id })` -> re-arm a fired listener (re-baseline).
- `perk_cancel({ id })` -> remove.

### Race-safety is the actual intellectual content (README commitment 4)

The serialization invariant: a fired listener must not inject while its target
session is mid-turn. Implementation: gate `promptAsync` on the idle set; queue
otherwise; drain the queue for a session when its `session.idle` arrives. One
mailbox per session, FIFO. This is where the design earns its keep; everything
else is plumbing.

---

## Findings during implementation (verified while building perk.ts)

### The plugin can be instantiated more than once per process

**This is the load-bearing implementation finding.** The `Plugin` function body
ran **twice** in a single `opencode serve` process (confirmed: "loading plugin"
logged twice, and two independent closures observed). The failure it caused:

- A `perk_*` tool call (running in instance A) enqueued a wake into A's mailbox.
- The `session.idle` event hook fired in instance B, whose mailbox was empty.
- B's `drain` saw nothing; A's queued wake was stranded forever.

Symptom: the first wake of a burst delivered fine (same instance handled both
the inject and the immediately-following idle), but a wake **queued behind a
busy turn** never drained on the next idle. Looked like a race in the idle gate;
was actually fragmented state across instances.

**Fix (do this in any harness with the same property): keep all mutable state in
a process-wide singleton, not in the plugin-function closure.** perk hangs a
single `PerkState` object off `globalThis` and starts exactly one poll loop
(guarded by a `pollStarted` flag). Each instance only wires its live `client`
into a shared `inject` slot (latest live client wins). After the singleton
refactor, the multi-wake serialization test passes regardless of instance count.

### Multi-wake serialization (verified)

Two listeners fired in the same idle window: the first injects (session goes
busy), the second stays queued in the per-session FIFO mailbox and drains on the
**next** `session.idle`, with no external nudge. Delivered in registration order.
This exercises README commitment 4 (turns serialized, never torn) directly.

### noReply backlog must self-reschedule (verified)

A `reply: false` wake injects context but runs **no turn**, so it emits no
`session.idle`. Nothing would re-invoke `drain`, so a backlog of context-only
notes behind one such wake would stall. Fix: after a successful noReply inject,
if items remain and the session is still idle, `setTimeout(drain, 0)` to flush
the next one. Reply wakes still pace on real idle events. Either way: strictly
one wake per tick, FIFO. Verified: two noReply notes, one idle event, both
delivered.

### create-listener baseline must advance INTO absence (verified)

Found via the self-test trial run. An `on:create` listener that was `perk_ack`-ed
while its file *existed* could **never** fire on a later absent->present edge.
Root cause: the poll's baseline-maintenance only advanced the baseline when the
file was present (`if (l.on === "create" && now.exists)`), so a transient
absence was erased: the baseline stayed `{exists:true}`, and `matches("create")`
(which needs `!base.exists && now.exists`) could never become true. Fix: advance
the baseline **into** absence instead (`if (l.on === "create" && !now.exists)`).
This is phantom-edge safe: advancing into absence is the only correct
armed-and-waiting state for a create listener, and the next present is a genuine
edge. Verified live: ack-while-present, then delete, then return -> fired.

### Never write logs to stdout/stderr inside the TUI (fixed)

Found via the trial run. `console.error("[perk]", ...)` wrote to stderr, which
the opencode TUI shares as its draw surface; the log lines corrupted the
display. **Any plugin running inside the TUI process must not touch the raw
stdout/stderr the renderer owns.** perk now appends to a log file
(`/tmp/perk.log`, configurable via `PERK_LOG`, `off` to silence) and swallows
logging errors so logging can never break the channel. Verified: zero `[perk]`
lines leak to the serve output; all events land in the log file.

### Baseline hygiene beats timing in testing

A trial-run "phantom re-fire" (a disarmed listener appearing to wake) was traced
to operator error, not a defect: a polluted baseline (leftover file + racey
`rm`/backgrounded-`touch` on one shell line) produced a genuine *extra* fire that
the FIFO mailbox faithfully delivered one turn late. The tell was `perk_list`:
`triggerCount` and `lastFired` were unchanged, so no actual re-fire occurred. The
edge-trigger/mailbox bookkeeping is correct as written. Lesson (now in
TESTING.md): start every test from a verified-clean baseline and confirm
`baselineExists` before scheduling the trigger. `POLL_MS = 300` is fine; timing
is not the fragile part.

### Test-harness ergonomics (full-protocol run; all 7 tests passed, no code bugs)

A second agent ran the entire TESTING.md protocol end to end: all seven tests
passed, the mechanism is sound, and *every* friction point was in the
choreography of driving the plugin from a slow, turn-based agent, not in the
plugin. The high-value fixes (now in TESTING.md):

- **Detached triggers are mandatory.** `(sleep N && touch ...) &` from an agent's
  `bash` tool is reaped when the tool call returns: the backgrounded subshell is
  a child of the tool's shell and stays in its process group. Triggers die before
  firing; symptom is a never-arriving wake or a stale `baselineExists: true`. Use
  `nohup zsh -c '...' >/dev/null 2>&1 & disown`. Verified empirically: a detached
  trigger survives across the tool-call boundary and fires; a `disown`ed job
  leaves the shell job table yet stays alive in `pgrep`.
- **Sleep must outlast a turn.** Agent per-turn latency can be ~10s, and you
  register on the turn *after* you schedule, so a `sleep 5` fires before you arm.
  Canonical value raised to `sleep 20`. This is distinct from baseline pollution:
  plain turn latency breaks a short sleep even with clean commands.
- **Silence tests need a specified wait + objective post-check.** Tests 2/6/7
  verify a listener does NOT wake the agent. Without a stated wait, a too-short
  wait yields a false pass (trigger had not fired yet). Each silence test now
  gives a concrete wait (`trigger_sleep + 5s`) and a `perk_list`-backed check:
  `triggerCount` proves the fire happened, the absence of a response turn proves
  the silence. Negative tests now leave hard evidence, not vibes.
- **Cancel finished listeners; don't ack them.** Acking re-snapshots the baseline
  from current state, which can strand a listener irrelevant to its intent (e.g.
  acking a `delete` listener while the target is already gone leaves it unable to
  fire). Tidy `pendingAck` with `perk_cancel`, not `perk_ack`.

The agent explicitly endorsed keeping as-is: the rich `perk_list` schema
(`armed`/`status`/`needsAck`/`triggerCount`/`lastFired`/`pendingAck`), which lets
a tester *prove* each test rather than infer it; the disarm-on-fire edge-trigger
default as the correct safety posture; and FIFO idle-gated drain working with
zero external nudges.

---

## Open questions / risks for the fresh session

1. **Multi-session state.** The probe used one session. Confirm a listener
   registered in session A wakes session A specifically (we capture its
   `sessionID`), and that two concurrent sessions don't cross wakes.
2. **`promptAsync` into an already-idle session vs. a never-started one.** The
   method says "start if needed." Verified into an existing session; confirm the
   "start if needed" path if a session could be idle/cold.
3. **Edge-trigger baseline semantics** for `on: "create"` when the file already
   exists (see stat-poll notes). Pick a rule, document it.
4. **mtime/size change detection corner**: same-mtime, same-size overwrite is
   undetectable by stat. Acceptable for POC; note it. (A content hash would
   close it but adds I/O.)
5. **`@opencode-ai/plugin` import resolution** in a bare single `.ts` with no
   local `package.json`. The probe imported `Plugin` and `tool` and loaded
   fine, so resolution works against the global opencode node_modules. Re-confirm
   after a clean checkout.
6. **noReply mode**: decide whether perk ever injects context-only notes
   (`noReply: true`) vs. always prompting a reply.

---

## Reproducing the test rig

```bash
# 1. boot a headless server in this dir (auto-loads .opencode/plugin/perk.ts)
opencode serve --port 4097 --print-logs --log-level INFO > /tmp/perk-serve.log 2>&1 &

# 2. inspect what loaded
curl -s http://127.0.0.1:4097/config | python3 -m json.tool | grep -A3 plugin
curl -s http://127.0.0.1:4097/doc  > /tmp/perk-openapi.json   # full OpenAPI

# 3. subscribe to the event stream (SSE: "data: {json}" per line)
curl -sN http://127.0.0.1:4097/event > /tmp/perk-events.log &

# 4. create a session (this triggers lazy plugin load)
curl -s -X POST http://127.0.0.1:4097/session \
  -H 'content-type: application/json' -d '{"title":"perk"}'
# -> {"id":"ses_...", ...}

# 5. inject a wake turn (fire-and-forget)
curl -s -X POST "http://127.0.0.1:4097/session/$SID/prompt_async" \
  -H 'content-type: application/json' \
  -d '{"model":{"providerID":"omlx","modelID":"Qwen3.6-35B-A3B-8bit"},
       "parts":[{"type":"text","text":"WAKE. Reply: PERK-OK"}]}'

# 6. watch /tmp/perk-serve.log for your plugin's console.error output,
#    and /tmp/perk-events.log for session.idle.
```

Local models available (no network, but cold-start lag on first request):
`omlx/Qwen3.6-35B-A3B-8bit` works. `omlx/gemma-4-26b-a4b-8bit` failed with a
"chat template not set" error in this run; avoid it for tests.

### The probe plugin used (reproduced for reference; deleted from the tree)

```ts
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const PerkProbe: Plugin = async ({ client, directory, worktree }) => {
  const log = (...a: unknown[]) => console.error("[perk-probe]", ...a)
  log("LOADED", { directory, worktree, pid: process.pid })
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "file.watcher.updated") {
        log("EVENT", event.type, JSON.stringify((event as any).properties))
      }
    },
    tool: {
      perk_ping: tool({
        description: "Probe tool: echoes back the session id and args.",
        args: { note: tool.schema.string().describe("anything") },
        async execute(args, ctx) {
          log("perk_ping called", { sessionID: ctx.sessionID, note: args.note })
          return `pong: sessionID=${ctx.sessionID} note=${args.note}`
        },
      }),
    },
  }
}
```

---

## Before fresh dev: `git init`

This directory is not a git repo (the probe showed `worktree = /`, i.e. opencode
walked all the way to root finding no worktree boundary). Run `git init` in
`/Users/adam/Desktop/perk` before building. Two reasons: (1) it gives the fresh
session a clean diff/checkpoint baseline for the real `perk.ts`, and (2) it sets
a proper `worktree`, which makes opencode's own behavior (and any future
in-project watch experiments) more representative.

**Heads-up: `opencode serve` materializes `.opencode/node_modules/`.** Booting
the server in this dir caused opencode to install the plugin dependency closure
(effect, zod, yaml, ...) into `.opencode/node_modules/`. A `.gitignore` is
already in place ignoring it. This is also why the bare-`.ts` import of
`@opencode-ai/plugin` resolves: the deps are present locally. Do not commit that
tree; do not be alarmed when it reappears.

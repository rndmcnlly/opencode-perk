# perk

*A minimal mechanism for letting a harnessed model perk up at the outside world.*

> **Design brief (historical).** This was the original brief written to instruct a future agent on what to build and why the shape matters. The plugin it describes now exists at [`.opencode/plugin/perk.ts`](.opencode/plugin/perk.ts) and is verified; see [`README.md`](./README.md) for user-facing docs. This document is preserved as the design rationale: it owns the *why* and the commitments. [`RESEARCH.md`](./RESEARCH.md) owns the verified *how* (primitives confirmed hands-on against opencode **1.15.12** on darwin).

## The one-sentence pitch

`perk` lets the model register interest in an external observable and get handed a conversational turn when that observable changes, so the model can react to the world instead of only responding to the human.

## The gap it fills

A harnessed model today is purely reactive in one direction: the human speaks, the model answers, the model goes quiet. The only thing that can produce the next turn is a person typing. The model cannot wait on anything, cannot be woken, cannot speak out of turn. Every "wait for X" today is faked by burning a turn on a blocking tool call, which freezes the conversation and the spend until X resolves.

`perk` adds the missing afferent channel. The model registers a listener ("tell me when this file changes"), ends its turn normally, and goes idle. Later, when the observable changes, the harness injects a turn as if the world had spoken. The human and the world become peers: either can produce the next turn. Whoever fires first wins; the other stays pending.

The key realization: **there is no blocking wait to interrupt.** "User-interruptible waiting" dissolves into "two turn-producers feeding one serialized conversation." The human typing and the world changing arrive through the same door. That door already half-exists in most harnesses; `perk` is the discipline that turns it into a clean, programmable sense.

## Design commitments (do not drift from these)

1. **Maximally generic.** The mechanism knows nothing about workflows, jobs, CI, timers, or any application. It knows only: *observe a thing, fire a turn on change.* Resist every temptation to bake a use case into the core. Monitoring workflow execution is just the first consumer, and it must be expressible without any special support.

2. **Build only on what the environment already provides.** Assume nothing exotic. The filesystem is the substrate: presence, absence, mtime, and contents of a path are the observables. A model that wants a five-minute timer writes `sleep 300 && touch /tmp/wake` with the tools it already has, then perks on `/tmp/wake`. We add a sense, not a runtime. No new daemon, no database, no queue, no server the user has to operate. (Verified caveat: the native watcher cannot see `/tmp`, so perk supplies its own stat-poll sense organ. See commitment 5 and RESEARCH.)

3. **Edge-triggered with explicit re-arming.** A listener fires once on a matching change, then disarms. The model must `ack` to re-arm. This prevents flapping files from spamming the conversation and makes the model's attention deliberate. Listing listeners shows trigger counts, last-fired, and armed/disarmed state. *Baseline semantics (settled):* `perk_register` takes a snapshot of the path at registration time and fires only on a *transition* away from that baseline. A path that already exists at register time does not fire `on: "create"` until it goes absent and returns.

4. **Turns are serialized, never torn.** A fired listener must not inject while the model is mid-turn. The injector gates on an idle signal and queues otherwise. One mailbox, delivered in order, no interrupts. Race-safety is the actual intellectual content; everything else is plumbing.

5. **Stay a plugin, not a fork.** The target harness ([opencode](https://github.com/anomalyco/opencode)) already exposes the two primitives this needs via its [plugin system](https://opencode.ai/docs/plugins/): a way to push a turn into a session by id (verified: [`client.session.promptAsync`](https://opencode.ai/docs/sdk/#sessions), fire-and-forget; `noReply: true` for context-only injection) and an [event stream](https://opencode.ai/docs/sdk/#events) ([`client.event.subscribe`](https://opencode.ai/docs/sdk/#events) / the `event` hook) that includes the idle ([`session.idle`](https://opencode.ai/docs/plugins/#session-events)) signal we gate on. The plugin lives at `.opencode/plugin/perk.ts`, auto-discovered with no config entry. *Settled empirical finding:* the built-in file watcher **cannot** see arbitrary absolute paths like `/tmp` (it watches only the project dir, behind an experimental flag, plus `.git`, and its ignore list contains `**/tmp/**`). So the "own-watch fallback" the original pitch hedged on is promoted to the primary and only path: perk runs a **stat-poll** loop over registered paths. The native `file.watcher.updated` event is therefore not consumed. One code path, not two. See RESEARCH for the verification.

## Shape of the tool surface (sketch, not spec)

- `perk_register({ path, on: "change" | "create" | "delete", message })` arm a listener; returns an id. `message` is the turn the model will receive when it fires.
- `perk_list()` show active listeners with trigger stats and armed state.
- `perk_ack({ id })` re-arm a listener that has fired.
- `perk_cancel({ id })` remove a listener.

The injected turn is just text the model authored at registration time, handed back to it later: a note-to-future-self that arrives when the world is ready. The model decides what to do on waking.

## What "done" looks like for the proof of concept

A single-file plugin where:

1. The model calls `perk_register` on a path with a wake message.
2. The model ends its turn; the session goes idle.
3. A human (or a `sleep && touch`) changes the path.
4. The model receives the wake turn, gated on idle, and speaks.

If that round-trips, the primitive is proven. Workflows, build-watchers, inbox-watchers, and timers are all just things that touch a file.

## Downstream applications (deliberately out of scope for the core)

- **Workflow monitoring.** Launch a long background job; perk on its completion sentinel. This is the motivating case, but it earns no special code.
- **Timers and scheduled wakeups.** `sleep N && touch`.
- **External events.** A webhook receiver, a mail fetcher, a CI poller: anything that can write a file becomes a sense.
- **Inter-agent signaling.** One agent's output file is another agent's perk.

### Composition: detached subagents via `opencode run`

This is the sharpest proof that perk is the missing half and nothing more. opencode's [`run`](https://opencode.ai/docs/cli/#run-1) command is a non-interactive, one-shot invocation of the whole harness. The agent already has `bash`, and the shell already has `&`. So a detached child needs no new launch primitive:

```bash
(opencode run "do the long thing; write results to /tmp/job-42.out" \
  && touch /tmp/job-42.done) &
```

The parent backgrounds it, ends its turn, and `perk_register`s on `/tmp/job-42.done`. The harness's own CLI is the actuator, the shell `&` is the detachment, and perk supplies the only missing piece: the wakeup. No subagent-specific code, in perk or anywhere.

It composes further than the bare sentinel:

- `--format json` lets the child emit structured events the parent parses on wake.
- `--session` / `--continue` / `--fork` let the wake turn reconnect to or fork the child's own session, not just read a file: the sentinel says "done," the session id hands back the full transcript.
- `--attach http://localhost:4096` lets a fleet of detached children share one warm `opencode serve`, avoiding cold-boot per spawn.

Today's built-in subagent ([Task tool](https://opencode.ai/docs/agents/)) is strictly *blocking*: the parent is suspended inside the tool call until the child returns. That is the same frozen-conversation pathology perk exists to dissolve. perk plus `opencode run` is the non-blocking version, available now, with the parent free to talk and to spawn more children meanwhile.

## Watch the harness (overlap and cheaper foundations)

opencode is actively building in this territory. Before writing code, check whether these have landed and whether they provide a cheaper foundation or a native answer to part of perk's job. Found in the [CLI env-var list](https://opencode.ai/docs/cli/#environment-variables):

- **`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`** ("Enable background subagent tasks") native non-blocking subagents. If this also ships its own completion-notification path, perk should *defer* to it for the subagent case rather than compete. perk's identity is the general filesystem sense, not subagent plumbing.
- **`OPENCODE_EXPERIMENTAL_EVENT_SYSTEM`** ("Enable experimental event system") directly adjacent to perk's wake-injection. The cheapest perk may ride this instead of inventing turn-injection from scratch.
- **`OPENCODE_EXPERIMENTAL_FILEWATCHER` / `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER`** ("file watcher for entire dir"). *Resolved:* even with the flag on, the native watcher reaches only the project dir and `.git`, never arbitrary paths like `/tmp`, and hardcodes `**/tmp/**` in its ignore list. This is why perk owns its stat-poll sense organ. See RESEARCH for the read-from-binary evidence.

The boundary to hold under all of this: **perk is the sense, not the plumbing.** A generic, filesystem-grounded afferent channel is the defensible core. Native background subagents and event systems are features perk *consumes or defers to*, not reasons it ceases to exist. If the harness grows a native answer to the subagent case, perk keeps its value as the general "react to any observable" mechanism that no subagent-specific feature covers.

## Prior art and how we differ

The 2026 landscape is thick with durable-execution engines for agents (Temporal-shaped: [aiki](https://github.com/aikirun/aiki), [Tianshu](https://github.com/Desicool/Tianshu-rs), [sagaflow](https://github.com/npow/sagaflow), [duralang](https://github.com/deepansh-saxena/DuraLang); CLI-flow runners: [stepwise](https://github.com/zackham/stepwise), [orc](https://github.com/jorge-barreto/orc), [zymi](https://github.com/metravod/zymi-core)). They all answer *how the workflow survives and resumes.* In all of them, "wait for event" means the **workflow** parks and a human fulfills it later through a separate channel; the agent walked away long ago. [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) is the canonical expression of this shape (`step.waitForEvent`), and [agentnb](https://github.com/oegedijk/agentnb) is the canonical expression of the operational shape we want (an agent-driven CLI with durable background runs: `runs wait`, `runs follow`).

`perk` answers a different and smaller question: *how the agent gets woken.* The durability of any long task is explicitly not our problem. We own only the sense organ. That single inversion is why this is a tiny plugin and not another orchestration platform, and why the conversational-interrupt problem disappears instead of needing machinery.

## Name

The agent perks up: ears lifting at a sound from outside. The tool prefix reads as the gesture.

## References

Load-bearing primitives (verify these first; the API may drift):

- [opencode plugins](https://opencode.ai/docs/plugins/) plugin module shape, the `client` SDK handle passed to every plugin, custom-tool registration, and the full [event list](https://opencode.ai/docs/plugins/#events). Note `tui.appendPrompt` / `tui.submitPrompt` as a human-facing alternative to session injection.
- [opencode SDK](https://opencode.ai/docs/sdk/) the client API surface. Key entries: [`session.promptAsync`](https://opencode.ai/docs/sdk/#sessions) (the verified injector: push a turn into a session by id, fire-and-forget; `noReply: true` injects context without a response), the synchronous [`session.prompt`](https://opencode.ai/docs/sdk/#sessions) (avoid from the watcher loop, it blocks until the reply finishes), [`session.abort`](https://opencode.ai/docs/sdk/#sessions), [`event.subscribe`](https://opencode.ai/docs/sdk/#events) (SSE stream), and the [`tui.*`](https://opencode.ai/docs/sdk/#tui) methods.
- [opencode SDK types](https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts) generated from the server OpenAPI spec; the ground truth for `Session`, `Message`, `Part`, and event payload shapes.
- [opencode source](https://github.com/anomalyco/opencode) the original empirical question (does the built-in file watcher reach arbitrary paths like `/tmp`?) has been **settled by reading the installed binary's watcher service: it does not.** See RESEARCH. Consult `packages/opencode` only if re-verifying after an API drift.
- [opencode CLI](https://opencode.ai/docs/cli/) the [`run`](https://opencode.ai/docs/cli/#run-1) command (detached children via `opencode run ... &`), [`serve`](https://opencode.ai/docs/cli/#serve) (warm shared server for `--attach`), and the [experimental env vars](https://opencode.ai/docs/cli/#environment-variables) to watch (`BACKGROUND_SUBAGENTS`, `EVENT_SYSTEM`, `FILEWATCHER`).
Conceptual reference points:

- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) the `step.waitForEvent` / durable-step vocabulary perk deliberately does *not* reimplement.
- [agentnb](https://github.com/oegedijk/agentnb) the agent-driven-CLI operational model (background runs, `runs wait` / `runs follow`) that the downstream workflow consumer should echo.

Prior art in the crowded durable-execution space (study for what *not* to rebuild):

- [stepwise](https://github.com/zackham/stepwise) nearest neighbor; an `external` executor that suspends a step and is fulfilled by anyone via `stepwise fulfill`. Human interaction is "go look at the web UI," not "wake the agent in place" the exact distinction perk turns on.
- [orc](https://github.com/jorge-barreto/orc) deterministic state-machine CLI with human gates and `--resume`.
- [persistent-agent-runtime](https://github.com/shenjianan97/persistent-agent-runtime), [aiki](https://github.com/aikirun/aiki), [sagaflow](https://github.com/npow/sagaflow), [duralang](https://github.com/deepansh-saxena/DuraLang), [zymi](https://github.com/metravod/zymi-core) Temporal-shaped or event-sourced durable-execution platforms. All own task durability, which perk explicitly does not.

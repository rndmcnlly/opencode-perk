# perk

*A minimal mechanism for letting a harnessed model perk up at the outside world.*

> **Proof of concept.** This repo demonstrates a general pattern: giving an
> agent a controllable way to *speak out of turn*, woken by the world rather
> than only by a human typing. The reference implementation is a single-file
> plugin for [opencode](https://opencode.ai), verified against **1.15.12**. The
> pattern is not specific to opencode. If you maintain a different agent
> harness, steal it.

## The idea in one sentence

`perk` lets a model register interest in an external observable and get handed a
conversational turn when that observable changes, so the model can react to the
world instead of only responding to the human.

## The gap it fills

A harnessed model today is purely reactive in one direction: the human speaks,
the model answers, the model goes quiet. The only thing that produces the next
turn is a person typing. The model cannot wait on anything, cannot be woken,
cannot speak out of turn. Every "wait for X" is faked by burning a turn on a
blocking call, which freezes the conversation (and the spend) until X resolves.

`perk` adds the missing afferent channel. The model registers a listener ("tell
me when this file changes"), ends its turn normally, and goes idle. Later, when
the observable changes, the harness injects a turn as if the world had spoken.
The human and the world become peers: either can produce the next turn.

The key realization: **there is no blocking wait to interrupt.**
"User-interruptible waiting" dissolves into "two turn-producers feeding one
serialized conversation." The human typing and the world changing arrive through
the same door.

## How it works (the pattern)

Two primitives, both of which most harnesses already have:

1. **A way to inject a turn into a session** out of band (here:
   opencode's fire-and-forget `client.session.promptAsync`).
2. **A sense organ** that watches the observable. perk uses a **stat-poll loop**
   over registered filesystem paths: presence, mtime, and size. The filesystem
   is the substrate, so anything that can `touch` a file becomes an event source
   (a timer is `sleep N && touch`; a job is `... && touch done`; a webhook
   receiver writes a file).

When a watched path changes, perk injects a turn into the registering session
**the instant it sees the change**, describing what happened. No queue, no idle
gate, no canned message: the wake text is generated from the listener id, the
path, and the observed transition. perk does not try to avoid landing a turn
mid-flight; an agent that cannot tolerate an interleaved notification should not
be using perk.

It is **edge-triggered**: a listener fires once, then disarms. The model must
`ack` to re-arm. This keeps a flapping file from spamming the conversation and
makes the model's attention deliberate.

## Install (opencode)

Drop [`.opencode/plugin/perk.ts`](.opencode/plugin/perk.ts) into your project's
`.opencode/plugin/` directory. It is auto-discovered, no config entry needed.
Boot opencode in that project and the three `perk_*` tools are available to the
model.

## Tool surface

| Tool | What it does |
| --- | --- |
| `perk_register({ path })` | Watch a path. The next change (appears, disappears, or contents change) hands you a turn saying so. Edge-triggered: fires once, then disarms. Returns an `id`. |
| `perk_ack({ id })` | Re-arm a listener that has fired (takes a fresh baseline). |
| `perk_cancel({ id })` | Stop watching: remove a listener. |

**Baseline semantics:** `perk_register` snapshots the path *now* and fires on
the first observed change away from that baseline: a path appearing,
disappearing, or its mtime/size changing. There is no need to declare which kind
of change you expect; perk reports what it saw and you decide what it means.

The injected turn names the listener id, the path, and the observed transition,
plus a reminder that the listener is now disarmed (ack to re-arm, cancel to
stop). The model decides what to do on waking.

## Example: a non-blocking background job

The agent already has `bash`, and the shell already has `&`. A detached child
needs no new launch primitive:

```bash
(opencode run "do the long thing; write results to /tmp/job-42.out" \
  && touch /tmp/job-42.done) &
```

The parent backgrounds it, ends its turn, and `perk_register`s on
`/tmp/job-42.done`. The harness's own CLI is the actuator, the shell `&` is the
detachment, and perk supplies the only missing piece: the wakeup. No
subagent-specific code anywhere.

## Scope

perk is **the sense, not the plumbing**. It owns waking the agent; it does *not*
own task durability, scheduling, or workflow state. That single inversion is why
this is a tiny plugin and not an orchestration platform, and why the
conversational-interrupt problem disappears instead of needing machinery. If a
harness grows native background tasks or event systems, perk consumes or defers
to them and keeps its value as the general "react to any observable" mechanism.

## Steal this

The reference implementation targets one harness, but the pattern is portable.
If your harness can inject a turn into a live session, you can build perk on top
of it. The watcher can be anything that produces a signal; the filesystem is
just the cheapest universal one.

## Try it / verify it

[`TESTING.md`](./TESTING.md) is a self-test written *for a perk-enabled agent*:
it walks the model through arming listeners, changing files with its own `bash`,
and observing itself getting woken. Point your agent at it to confirm the
primitive end to end (and to feel the round-trip from the inside).

## Name

The agent perks up: ears lifting at a sound from outside. The tool prefix reads
as the gesture.

## License

[MIT](./LICENSE).

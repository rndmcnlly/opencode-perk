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
Boot opencode in that project and the `perk_*` tools are available to the
model.

## Tool surface

| Tool | What it does |
| --- | --- |
| `perk_register({ path })` | Watch a path. The next change (appears, disappears, or contents change) hands you a turn saying so. Edge-triggered: fires once, then disarms. Returns an `id`. |
| `perk_ack({ id })` | Re-arm a listener that has fired (takes a fresh baseline). |
| `perk_cancel({ id })` | Stop watching: remove a listener. |
| `perk_bash_background({ command })` | Run a shell command as a detached fire-and-forget job. Returns *immediately* (does not block), captures stdout/stderr/exit-code to files under the project `.perk/` dir, and arms a one-shot listener; perk wakes you on completion with the exit code and the byte sizes + paths of the captured output, then auto-removes the listener (no ack). No paths to choose. |
| `perk_wait({ timeout_s? })` | **Headless escape hatch.** Blocks the current turn until a perk event fires (or timeout), then returns a bare "awoken"; the actual wake message follows as the next turn. Use only when no human is present (e.g. `opencode run`), where ending a turn would exit the process before the wake could land. Interactively, just end your turn instead. |

**Baseline semantics:** `perk_register` snapshots the path *now* and fires on
the first observed change away from that baseline: a path appearing,
disappearing, or its mtime/size changing. There is no need to declare which kind
of change you expect; perk reports what it saw and you decide what it means.

The injected turn names the listener id, the path, and the observed transition,
plus a reminder that the listener is now disarmed (ack to re-arm, cancel to
stop). The model decides what to do on waking.

## Example: a non-blocking background job

The whole point of the afferent channel is to stop faking "wait for X" by
blocking a turn. `perk_bash_background` is the ergonomic case: hand it a command
and nothing else. It runs the command detached, returns immediately, captures
stdout/stderr/exit-code to files for you, and arms a one-shot listener.

```
perk_bash_background({
  command: "opencode run 'do the long thing'",
})
```

You end your turn and go idle; when the command exits, perk hands you a turn
reporting the exit code and the byte sizes (and paths) of the captured output,
so you can read the output files only if there is something worth reading. No
polling, no blocked turn, no paths to invent, no hand-rolled backgrounding.

Output and the exit code land under a project-local `.perk/` directory (kept in
the project, not `/tmp`, so opencode does not prompt for out-of-worktree
access). The listener auto-removes when it fires: a finished job needs no `ack`.

If you want a **public rendezvous** file that other tools/agents/humans can wait
on, just write it yourself inside the command; that is rare enough not to deserve
a parameter:

```
perk_bash_background({ command: "make build && touch shared-build.done" })
```

The mechanism is deliberately not magic. The detachment (`detached` spawn) and
the capture live *inside the tool*; the only new capability perk supplies over
plain `bash` + `&` is the wakeup. If you prefer to background work yourself, you
still can: any `touch`-on-completion plus a `perk_register` gives the same
result.

```bash
(opencode run "do the long thing" && touch .perk/job-42.done) &
```

Then `perk_register` on `.perk/job-42.done`. The shell `&` is the detachment;
perk is just the sense organ that notices the file appear.

> **Why a dedicated tool and not a flag on `bash`?** An earlier design hooked the
> builtin `bash` and silently rewrote the agent's `command` into detach
> scaffolding before running it. Since the transcript is the agent's only memory,
> the agent would later read scaffolding it never typed and conclude it had erred
> (see issue #2). A separate tool records exactly what the agent typed; the
> scaffolding stays inside the implementation where it belongs.

## Interactive vs. headless: a turn that ends is not always a turn that idles

perk's wake works by *injecting a turn into a live session*. That assumes the
session is still running after the agent stops. In the **interactive** TUI that
holds: ending a turn means going idle, the process keeps running, and the human
typing or perk's injection both produce the next turn. Ending the turn is
strictly the right move: no blocking, no wasted spend, woken for free.

In a **headless** run (`opencode run`), ending a turn means the **process
exits**. There is no idle state to wake; the injected turn would arrive into
nothing. So an agent that "ends its turn to wait," a reflex that is correct
interactively, silently breaks the round-trip exactly where fire-and-forget
matters most.

`perk_wait` is the escape hatch for that case. It is a *blocking* tool call:
it parks the current turn until a perk event fires (or a timeout), keeping the
process alive so the wake can land. It returns a bare "awoken"; the real wake
message arrives as the very next turn, identical to interactive mode (one wake
path, both modes). The rule the tools advise:

- **Human present (interactive):** end your turn. Do not call `perk_wait`.
- **No human (headless / unattended):** call `perk_wait` instead of ending your
  turn.

This deliberately reintroduces a blocking wait, the very thing perk's thesis
dissolves, but only where the thesis does not apply: with no live host, there is
no conversation to interrupt, and blocking is the only way not to exit. The two
modes genuinely want opposite mechanisms.

> **Caveat (poka-yoke gap):** the plugin cannot currently tell from its inputs
> whether it is interactive or headless, so it cannot enforce this; it can only
> advise via the tool descriptions. Closing that gap (detecting run mode and
> hard-steering the agent) is open work.

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

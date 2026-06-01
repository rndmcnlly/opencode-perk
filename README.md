# perk

*A minimal mechanism for letting a harnessed model perk up at the outside world.*

> **Proof of concept.** This repo demonstrates a general pattern: giving an
> agent a controllable way to *speak out of turn*, woken by the world rather
> than only by a human typing. The reference implementation is a single-file
> plugin for [opencode](https://opencode.ai), verified against **1.15.13**. The
> pattern is not specific to opencode. If you maintain a different agent
> harness, steal it.

## The idea in one sentence

`perk` lets a model fire off a background job and get handed a conversational
turn when that job finishes, so the model can react to the world instead of
only responding to the human.

## The gap it fills

A harnessed model today is purely reactive in one direction: the human speaks,
the model answers, the model goes quiet. The only thing that produces the next
turn is a person typing. The model cannot wait on anything, cannot be woken,
cannot speak out of turn. Every "wait for X" is faked by burning a turn on a
blocking call, which freezes the conversation (and the spend) until X resolves.

`perk` adds the missing afferent channel. The model fires a background job, ends
its turn normally, and goes idle. Later, when the job finishes, the harness
injects a turn as if the world had spoken. The human and the world become peers:
either can produce the next turn.

The key realization: **there is no blocking wait to interrupt.**
"User-interruptible waiting" dissolves into "two turn-producers feeding one
serialized conversation." The human typing and the world finishing a job arrive
through the same door.

## One primitive

perk is a single tool.

| Tool | What it does |
| --- | --- |
| `perk_bash_background({ command })` | Run a shell command as a detached fire-and-forget job. Returns *immediately* (does not block) with the job's `pgid` and the paths to its captured stdout / stderr / exit-code files (under the project `.perk/` dir). When the job finishes, perk injects a turn reporting the exit code and the byte sizes of the captured output. |

That's the whole surface. Earlier versions also had `perk_register` /
`perk_ack` / `perk_cancel` (watch an arbitrary path, re-arm, stop) and
`perk_wait` (a headless blocking escape hatch). All four are gone, because each
reduces to the single primitive (see ["What the four retired tools
reduce to"](#what-the-four-retired-tools-reduce-to)).

## How it works (the pattern)

Two ingredients, both of which most harnesses already have:

1. **A way to inject a turn into a session** out of band (here:
   opencode's fire-and-forget `client.session.promptAsync`).
2. **A sense organ** that watches the observable. perk uses a **stat-poll loop**
   over the one thing it needs to watch: each running job's *exit-code file*.
   The job's wrapper writes that file last, atomically, only when the job is
   truly done, so its appearance is a sound completion signal.

When a job's exit file appears, perk injects a turn into the firing session
describing the outcome (exit code, captured-output sizes and paths). The wake
text is generated, not canned. perk does not try to avoid landing a turn
mid-flight; an agent that cannot tolerate an interleaved notification should not
be using perk.

## Install (opencode)

Drop [`.opencode/plugin/perk.ts`](.opencode/plugin/perk.ts) into your project's
`.opencode/plugin/` directory. It is auto-discovered, no config entry needed.
Boot opencode in that project and `perk_bash_background` is available to the
model.

## Example: a non-blocking background job

The whole point of the afferent channel is to stop faking "wait for X" by
blocking a turn. Hand `perk_bash_background` a command and nothing else:

```
perk_bash_background({ command: "make build" })
```

It runs the command detached, returns immediately, and captures
stdout/stderr/exit-code to files for you. You end your turn and go idle; when the
build exits, perk hands you a turn reporting the exit code and the byte sizes
(and paths) of the captured output, so you read the output files only if there
is something worth reading. No polling, no blocked turn, no paths to invent, no
hand-rolled backgrounding.

Output and the exit code land under a project-local `.perk/` directory (kept in
the project, not `/tmp`, so opencode does not prompt for out-of-worktree
access).

## Killing a job, and "die with opencode"

`perk_bash_background` returns the job's **process-group id** (`pgid`). Because
the job is spawned `detached` it is its own process-group leader, so a single
signal to the negated pgid reaps the whole tree (the wrapper, the command, and
anything the command spawned):

```bash
kill -TERM -<pgid>      # leading minus = signal the whole process group
```

This matters for long-lived jobs like preview/dev servers
(`perk_bash_background({ command: "npm run dev" })`): the agent gets a kill
handle instead of an unstoppable orphan.

Jobs also **die with opencode on a graceful shutdown.** The plugin tracks every
running job and group-kills the survivors in its `dispose` hook, which opencode
calls on teardown (verified: a `sleep 90` fired via `perk_bash_background` is
reaped when `opencode run` exits). The one case this cannot cover is a hard
crash or `kill -9` of opencode itself (uncatchable); the returned pgid is the
manual remedy there.

## Interactive vs. headless: end your turn, or block in foreground

perk's wake works by *injecting a turn into a live session*. That assumes the
session is still running after the agent stops.

- **Human present (interactive TUI):** ending a turn means going idle, the
  process keeps running, and the human typing or perk's injection both produce
  the next turn. **Just end your turn.** No blocking, no wasted spend, woken for
  free. This is strictly the right move.

- **No human (headless, `opencode run`):** ending a turn means the **process
  exits**, so there is no idle state to wake and the injected turn would arrive
  into nothing. Instead, block in **foreground bash** on the exit-file path the
  tool already handed you:

  ```bash
  until [ -e <exit-file> ]; do sleep 0.3; done
  ```

  That is the blocking wait, in plain bash, with no plugin machinery. The exit
  file is written only when the job is truly done (output files are flushed
  first, then the exit code is written atomically), so the loop is a correct
  completion gate. When it returns, read the captured output.

This is the same insight that retired `perk_wait`: the headless wait is just a
bash poll on the rendezvous file perk already gives you.

> **Caveat (poka-yoke gap):** the plugin cannot currently tell from its inputs
> whether it is interactive or headless, so it cannot enforce this; it can only
> advise via the tool description. Closing that gap (detecting run mode and
> hard-steering the agent) is open work.

## What the four retired tools reduce to

The single-primitive claim rests on these reductions:

- **`perk_register({ path })`** ("watch an arbitrary observable") becomes a job
  that blocks until the observable changes, then exits:

  ```
  perk_bash_background({ command: "until [ -e some.file ]; do sleep 0.3; done" })
  ```

  The poll loop that used to live inside the plugin now lives inside the
  command. perk keeps exactly one sense organ (a job's exit-code file) instead
  of two (that file plus a generic stat-poll over registered paths). Anything
  that can be expressed as "wait for a shell condition" is now in scope, which
  is *more* general than the old fixed appear/disappear/mtime triggers.

- **`perk_ack({ id })`** was just "re-register." A fresh `perk_bash_background`
  per event covers it.

- **`perk_cancel({ id })`** was barely better than neglecting to ack. Job
  listeners now auto-remove on completion; to stop a *running* job, kill it via
  its pgid.

- **`perk_wait({ timeout_s })`** was the headless blocking escape hatch. It is
  replaced by the foreground `until [ -e <exit-file> ]; do sleep 0.3; done`
  shown above: the same blocking wait, in bash, on the file perk already
  returns.

## Why a dedicated tool and not a flag on `bash`

An earlier design hooked the builtin `bash` and silently rewrote the agent's
`command` into detach scaffolding before running it. Since the transcript is the
agent's only memory, the agent would later read scaffolding it never typed and
conclude it had erred (see issue #2). A separate tool records exactly what the
agent typed; the scaffolding stays inside the implementation where it belongs.

## Scope, and how perk relates to background-*agent* plugins

perk is **the sense, not the plumbing**. It owns waking the agent; it does *not*
own task durability, scheduling, result persistence, or workflow state. That
single inversion is why this is a tiny plugin and not an orchestration platform,
and why the conversational-interrupt problem disappears instead of needing
machinery.

This is the opposite end from delegation plugins like
[`kdcokenny/opencode-background-agents`](https://github.com/kdcokenny/opencode-background-agents),
which is the **efferent** side: delegate a *sub-agent*, persist its distilled
result to markdown so it survives context compaction, and notify on completion.
That plugin is about *what to run and how to remember its output*; perk is about
*how the world gets a turn*. perk does not care what produced the signal: a
build, a timer, a sub-agent, a webhook receiver writing a file. They compose
cleanly: a delegation plugin could use perk as its wake mechanism, or perk can
wrap a sub-agent run directly:

```
perk_bash_background({ command: "opencode run 'do the long research thing'" })
```

If a harness grows native background tasks or event systems, perk consumes or
defers to them and keeps its value as the general "react to any observable"
mechanism.

## Steal this

The reference implementation targets one harness, but the pattern is portable.
If your harness can inject a turn into a live session, you can build perk on top
of it. The watcher can be anything that produces a signal; the filesystem is
just the cheapest universal one.

## Try it / verify it

[`TESTING.md`](./TESTING.md) is a self-test written *for a perk-enabled agent*:
it walks the model through firing background jobs with its own
`perk_bash_background`, blocking on the rendezvous file, and observing itself
getting woken. Point your agent at it to confirm the primitive end to end (and
to feel the round-trip from the inside).

## Name

The agent perks up: ears lifting at a sound from outside. The tool prefix reads
as the gesture.

## License

[MIT](./LICENSE).

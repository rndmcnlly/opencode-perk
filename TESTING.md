# Testing perk (from inside a perk-enabled agent)

This guide is written **for an agent** running in an opencode session where
`.opencode/plugin/perk.ts` is loaded. You exercise the plugin on yourself: arm
listeners, change files with your own `bash` tool, and observe yourself getting
woken. No external harness, no HTTP. Your conversation *is* the test rig.

perk has two surfaces, tested in turn below:

1. **The afferent channel** (`perk_register` / `perk_ack` / `perk_cancel`): watch
   a path, get a turn when it changes.
2. **The `bash` `perk` arg**: run a command as a fire-and-forget background job
   and be woken with its exit code.

## How to read this guide

This protocol **sets up the hoops and states what counts as passing. It does not
teach you how the tools work.** Read each tool's own description (and the wake /
return notices it emits) for that. This is deliberate: the docstrings are what we
are testing. If you find yourself unsure how to use a tool, that uncertainty is
itself a finding to report, not a gap for this file to paper over. Use the tools
as their own descriptions tell you to, and report anything that surprised you.

## Rig setup (facts about the test, not about the tools)

- Be in a **fresh opencode session**. Plugin-augmented tool schemas only reach
  the model when the tool list is built; a stale session may not offer the `perk`
  arg. If a tool seems inert in a confirmed-fresh session, check `/tmp/perk.log`
  for load errors before calling it a test failure.
- Use `/tmp` for all paths. Pick fresh paths that do not already exist; clean up
  at the end.
- **A scheduled change must outlast one of your turns.** Per-turn latency (model
  thinking + tool round-trips) can be ~10s, and you arm on the turn *after* you
  schedule. Use **`sleep 20`** as the canonical delay: above `POLL_MS`, longer
  than a turn.
- **Baseline hygiene.** A listener snapshots the path's state when armed and fires
  on the first change away from it. Put the target in a known state (`rm -f` or
  `touch`) *before* arming, so the change you schedule is a real transition, not
  leftover noise.
- Plugin logs go to `/tmp/perk.log` (never the terminal: stderr would corrupt the
  TUI). `tail -f /tmp/perk.log` in another shell to watch `fired` events.
  `PERK_LOG=off` silences.

> **Scheduling a delayed trigger:** use the `bash` `perk` arg for it (e.g. a
> `sleep 20` job that writes a path). That is the documented way to run a job that
> outlives the call; you do not need to hand-roll backgrounding. When a test
> watches path X, have the trigger touch X via a job whose *own* sentinel is a
> *different* path, so the wake you are testing for is the one you mean to test.

---

# Part 1: the afferent channel

## Test 1: the core round-trip

The one that matters. Everything else is refinement.

1. `rm -f /tmp/perk-test-1` (known state).
2. `perk_register` the path `/tmp/perk-test-1`.
3. Schedule a delayed `touch /tmp/perk-test-1` that outlives your turn (see the
   scheduling note; use the `perk` arg, with its own separate sentinel).
4. **End your turn.** Say one short sentence ("Armed test 1; waiting.") and stop.
   Do not poll, loop, or call more tools. Going idle is the point.

**Pass:** a turn arrives on its own (no human typed it) reporting that the watched
path appeared. **Fail:** no turn ever arrives.

## Test 2: edge-trigger discipline (no re-fire without ack)

After Test 1 wakes you, change the file again **without acking**
(`echo more >> /tmp/perk-test-1`), then end your turn.

**Pass:** **no** wake arrives; the disarmed listener ignored the change. (You sit
idle until a human speaks; that silence is success.)
**For the human:** after the agent goes idle, wait a couple of seconds, then send
any short message. No autonomous wake before your message is the proof.

## Test 3: re-arming with ack

1. On a human-given turn, `perk_ack` the test-1 listener.
2. Schedule another delayed change to the same file (`echo again >> ...`).
3. End your turn.

**Pass:** you are woken again, reporting the path changed.

## Test 4: delete is detected too

`touch /tmp/perk-test-del` (exists at arm time), `perk_register` it, schedule a
delayed `rm -f /tmp/perk-test-del`, end your turn.

**Pass:** you are woken reporting the path disappeared.

## Test 5: cancel

`perk_register` `/tmp/perk-test-cancel` (ensure it does not exist), immediately
`perk_cancel` that listener, then schedule its delayed trigger and end your turn.

**Pass:** **no** wake arrives. **For the human:** after the agent goes idle, wait
~25s (so the trigger fires), then send any short message. The silence proves
cancel removed the listener.

---

# Part 2: the `bash` `perk` arg

## Test A: round-trip

1. Use the `perk` arg in `bash` to run `sleep 20; true`, sentinel
   `/tmp/job-a.done`.
2. **End your turn.** One short sentence, then stop. Do not poll.

**Pass:** the call returns effectively instantly (it does not block for the
`sleep`), **and** a turn later arrives on its own reporting a clean exit. Both
halves must hold.

## Test B: nonzero exit

Use the `perk` arg in `bash` to run `sleep 20; exit 17`, sentinel
`/tmp/job-b.done`. End your turn.

**Pass:** you are woken on your own, and the wake reports exit code 17.

## Test C: plays well with others

1. Use the `perk` arg in `bash` to run `sleep 20`, sentinel `/tmp/job-c.done`.
2. In a **separate, plain (no `perk`)** `bash` call, block on that same path and
   read it:
   `while [ ! -e /tmp/job-c.done ]; do sleep 1; done; echo "code=$(cat /tmp/job-c.done)"`

**Pass:** the second call eventually returns `code=0`. (A perk wake for the same
path may also arrive; both observers are valid.)

---

## Cleanup

```bash
rm -f /tmp/perk-test-1 /tmp/perk-test-del /tmp/perk-test-cancel \
      /tmp/job-a.done /tmp/job-b.done /tmp/job-c.done
```

Cancel any listeners still armed with `perk_cancel`.

---

## Known limitation to keep in mind

The watcher compares `{ exists, mtimeMs, size }`. A **same-mtime, same-size
overwrite** is invisible to it, so a content change that moves neither mtime nor
size can be missed. Accepted proof-of-concept tradeoff (a content hash would close
it at the cost of reading every watched file each poll). Do not treat a missed
same-stat overwrite as a bug.

## Report back on

- Did each tool's own description give you enough to use it correctly on the first
  try, or did something surprise you mid-test? **Name the surprise.** (This is the
  primary signal: the protocol withholds the mechanism on purpose.)
- Was the wake verdict (appeared / changed / disappeared; clean / exit code N)
  unambiguous?
- Anything about the `perk` arg (the value being the sentinel path, the rewritten
  command appearing in your transcript, the immediate return) that read wrong?
- Any confusion about the fresh-session requirement?

## What a full pass demonstrates

- An afferent channel: the world produced a turn, not a human (Test 1).
- Deliberate attention via edge-trigger + ack (Tests 2, 3).
- Best-effort detection of appearance, change, disappearance (Tests 1, 3, 4).
- Clean teardown (Test 5).
- Fire-and-forget jobs that return immediately and report their exit code on their
  own (Tests A, B), over a sentinel that doubles as public rendezvous (Test C).

# Testing perk (from inside a perk-enabled agent)

This guide is written **for an agent** running in an opencode session where
`.opencode/plugin/perk.ts` is loaded. You will exercise the plugin on yourself:
register listeners, change files with your own `bash` tool, and observe yourself
getting woken. No external test harness, no HTTP. Your conversation *is* the
test rig.

The whole proof rests on one self-referential move: **you arm a listener, end
your turn, and a background `touch` you scheduled wakes you back up.** If you get
the wake turn, the afferent channel works.

> Use `/tmp` for all targets. It is the canonical watch location and keeps the
> project tree clean. Clean up your sentinels at the end.

---

## Test 1: the core round-trip (create)

This is the one that matters. Everything else is a refinement.

1. Schedule a delayed file creation that outlives your turn, **backgrounded** so
   it does not block you:

   ```bash
   (sleep 5 && touch /tmp/perk-test-create) &
   ```

   Make sure the file does not already exist first (`rm -f /tmp/perk-test-create`).

2. Immediately register a listener for its creation:

   `perk_register({ path: "/tmp/perk-test-create", on: "create", message: "WAKE 1: /tmp/perk-test-create was created. Acknowledge that test 1 passed." })`

3. **End your turn.** Say one short sentence like "Armed test 1; waiting." and
   stop. Do not poll, do not loop, do not call any more tools. Going idle is the
   point: the wake can only arrive when you are idle.

**Pass:** a new turn arrives on its own (no human typed it) carrying "WAKE 1
...". You react to it. That is the entire primitive, proven.

**Fail:** no turn ever arrives. Then the watcher, the idle gate, or the injector
is broken. On your next human-given turn, call `perk_list` to inspect state and
read the design in `RESEARCH.md`.

---

## Test 2: edge-trigger discipline (no re-fire without ack)

A fired listener must disarm and stay silent until you `perk_ack` it.

1. After Test 1 wakes you, call `perk_list`. The listener from test 1 should
   show `status: "fired-needs-ack"`, `armed: false`, `triggerCount: 1`, and the
   top-level `pendingAck` should be at least 1.

2. Change the file again **without acking**:

   ```bash
   echo more >> /tmp/perk-test-create
   ```

3. End your turn.

**Pass:** **no** wake arrives. The disarmed listener ignored the change. (You
will simply sit idle until a human speaks. That silence is success here.)

---

## Test 3: re-arming with ack

1. On a human-given turn, re-arm the test-1 listener:
   `perk_ack({ id: <that id> })`. This takes a fresh baseline from the file's
   current state.

2. Because the file currently *exists*, an `on: "create"` listener will only
   fire again after the file goes **absent then present**. Schedule exactly
   that, backgrounded:

   ```bash
   (sleep 5 && rm -f /tmp/perk-test-create && sleep 1 && touch /tmp/perk-test-create) &
   ```

3. End your turn.

**Pass:** you are woken again with the same message. This confirms ack restores
the listener and that the baseline is re-snapshotted (the create edge is
relative to "absent at ack time" — here, absent again mid-sequence).

---

## Test 4: change and delete triggers

Repeat the round-trip for the other two transition types. Pre-create the target
so `change`/`delete` have something to transition from.

**change:**

```bash
touch /tmp/perk-test-change          # exists at register time
```
`perk_register({ path: "/tmp/perk-test-change", on: "change", message: "WAKE: change fired." })`
```bash
(sleep 5 && echo data >> /tmp/perk-test-change) &
```
End turn. **Pass:** woken on the mtime/size change.

**delete:**

```bash
touch /tmp/perk-test-delete          # exists at register time
```
`perk_register({ path: "/tmp/perk-test-delete", on: "delete", message: "WAKE: delete fired." })`
```bash
(sleep 5 && rm -f /tmp/perk-test-delete) &
```
End turn. **Pass:** woken when the file disappears.

---

## Test 5: serialization (turns are never torn)

The injector must wait for you to be idle. To see this, arm a listener and fire
it while you are deliberately busy, then confirm the wake lands *after* your work
finishes, not in the middle of it.

1. `perk_register({ path: "/tmp/perk-test-serial", on: "create", message: "WAKE: serial test — this should have arrived only after my long bash finished." })`
   (ensure `/tmp/perk-test-serial` does not exist).

2. In a single turn, schedule the trigger to fire *while* a long foreground
   command is still running:

   ```bash
   (sleep 3 && touch /tmp/perk-test-serial) &   # fires ~3s in
   sleep 8                                       # you stay busy for ~8s
   echo "long work done"
   ```

   Do not end your turn early; let the `sleep 8` complete in the same turn.

**Pass:** the trigger fires at ~3s (mid-turn), but the wake message does **not**
interrupt. It arrives as a fresh turn only after your turn settles to idle
(~8s+). The conversation is never torn.

## Test 5b: two wakes queued, delivered in order

Confirms the per-session FIFO mailbox: when two listeners fire close together,
the first wakes you and the second waits behind it, delivered on the *next* idle
with no external nudge.

1. Ensure both targets exist (so `change`/`delete` have a baseline):

   ```bash
   touch /tmp/perk-test-a /tmp/perk-test-b
   ```

2. Register two listeners in one turn:
   - `perk_register({ path: "/tmp/perk-test-a", on: "change", message: "WAKE A: reply A-SEEN" })`
   - `perk_register({ path: "/tmp/perk-test-b", on: "delete", message: "WAKE B: reply B-SEEN" })`

3. Fire both nearly simultaneously, then end your turn:

   ```bash
   (sleep 5 && echo x >> /tmp/perk-test-a && rm -f /tmp/perk-test-b) &
   ```

**Pass:** you receive **two** separate wake turns, A then B (registration order).
The second arrives only after you finish responding to the first. If only the
first ever arrives, the mailbox or the idle-gated drain is broken (historically
this was caused by per-instance state instead of a shared singleton: see
`RESEARCH.md`).

---

## Test 6: context-only injection (reply: false)

A listener can deliver a silent note instead of prompting a response.

1. `perk_register({ path: "/tmp/perk-test-noreply", on: "create", message: "FYI note: silent context, no reply expected.", reply: false })`
   (ensure the path does not exist).

2. ```bash
   (sleep 5 && touch /tmp/perk-test-noreply) &
   ```
   End your turn.

**Pass:** the note is appended to the conversation **without** triggering a new
response turn from you. You will only "see" it the next time a human (or another
wake) prompts you. Compare with Test 1, where `reply` defaults to true and you
*do* respond.

---

## Test 7: cancel

1. Register any listener, then immediately `perk_cancel({ id: <that id> })`.
2. `perk_list` should no longer show it.
3. Trigger its path; **no** wake should arrive.

---

## Cleanup

```bash
rm -f /tmp/perk-test-create /tmp/perk-test-change /tmp/perk-test-delete \
      /tmp/perk-test-serial /tmp/perk-test-noreply /tmp/perk-test-a /tmp/perk-test-b
```

Cancel any listeners still registered (`perk_list` then `perk_cancel` each id).

---

## Known limitation to keep in mind

The watcher compares `{ exists, mtimeMs, size }`. A **same-mtime, same-size
overwrite** is invisible to it, so a `change` listener can miss such a write.
This is an accepted proof-of-concept tradeoff (a content hash would close it at
the cost of reading every watched file each poll). Do not treat a missed
same-stat overwrite as a bug.

## What a full pass demonstrates

- An afferent channel: the world produced a turn, not a human (Test 1).
- Deliberate attention via edge-trigger + ack (Tests 2, 3).
- All three filesystem transitions as observables (Tests 1, 4).
- Serialization: turns are never torn (Test 5).
- Both delivery modes: reply and context-only (Tests 1, 6).
- Clean teardown (Test 7).

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

> **Detach every scheduled trigger, or it will die before it fires.** The naive
> `(sleep 5 && touch ...) &` issued from an agent's `bash` tool is a trap: the
> backgrounded subshell is a child of the tool invocation's shell and stays in
> its process group, so when the tool call returns (or is aborted) the job can be
> reaped and the `sleep` dies before firing. Symptom: you arm a listener, go
> idle, and never get woken. Always fully detach:
>
> ```bash
> nohup zsh -c 'sleep 20 && touch /tmp/perk-test-1' >/dev/null 2>&1 & disown
> ```
>
> `nohup` + output redirect + `disown` removes it from the shell's job table and
> detaches it from the controlling terminal, so it outlives the tool call. Verify
> survival with `pgrep -fl sleep` across two tool calls if unsure. Every snippet
> below uses this form.

> **The sleep must outlast one of your turns.** Your per-turn latency (model
> thinking + tool round-trips) can be ~10s. You schedule the trigger on one turn
> and `perk_register` on the *next*, so a short `sleep 5` may fire before you
> register. Use **`sleep 20`** as the canonical value (plenty above
> `POLL_MS = 300`, comfortably longer than a turn).

> **Baseline hygiene.** `perk_register` snapshots the path's current state and
> fires on the first change away from it. Put the target in a known state
> (`rm -f` it, or `touch` it) *before* registering so the change you schedule is
> a real transition and not noise from a leftover file.

> Plugin logs go to `/tmp/perk.log` (not the terminal: writing to stderr would
> corrupt the TUI). `tail -f /tmp/perk.log` in another shell to watch `fired`
> events. Set `PERK_LOG=off` to silence, or point it at another path.

---

## Test 1: the core round-trip

This is the one that matters. Everything else is a refinement.

1. Schedule a delayed file creation that outlives your turn, **fully detached**
   so it survives past this tool call (see the detach note above):

   ```bash
   rm -f /tmp/perk-test-1   # known state first
   nohup zsh -c 'sleep 20 && touch /tmp/perk-test-1' >/dev/null 2>&1 & disown
   ```

2. Immediately register a listener for it:

   `perk_register({ path: "/tmp/perk-test-1" })`

3. **End your turn.** Say one short sentence like "Armed test 1; waiting." and
   stop. Do not poll, do not loop, do not call any more tools. Going idle is the
   point.

**Pass:** a new turn arrives on its own (no human typed it) saying the watched
path `appeared`. You react to it. That is the entire primitive, proven.

**Fail:** no turn ever arrives. Then the watcher or the injector is broken.
Check `/tmp/perk.log` for a `fired` line on your next human-given turn.

---

## Test 2: edge-trigger discipline (no re-fire without ack)

A fired listener must disarm and stay silent until you `perk_ack` it.

1. After Test 1 wakes you, change the file again **without acking**:

   ```bash
   echo more >> /tmp/perk-test-1
   ```

2. End your turn.

**Pass:** **no** wake arrives. The disarmed listener ignored the change. (You
will simply sit idle until a human speaks. That silence is success here.)

**For the human driving this:** after the agent goes idle, wait a couple of
seconds (the `echo` is synchronous, so it has already fired by the time the agent
is idle), then send any short message. No autonomous wake between idle and your
message is the proof.

---

## Test 3: re-arming with ack

1. On a human-given turn, re-arm the test-1 listener:
   `perk_ack({ id: <that id> })`. This takes a fresh baseline from the file's
   current state.

2. Schedule another change, fully detached:

   ```bash
   nohup zsh -c 'sleep 20 && echo again >> /tmp/perk-test-1' >/dev/null 2>&1 & disown
   ```

3. End your turn.

**Pass:** you are woken again, saying the path `changed`. This confirms ack
restores the listener and re-snapshots the baseline.

---

## Test 4: delete is detected too

The same single tool reports disappearance, not just creation or change.

```bash
touch /tmp/perk-test-del          # exists at register time
```
`perk_register({ path: "/tmp/perk-test-del" })`
```bash
nohup zsh -c 'sleep 20 && rm -f /tmp/perk-test-del' >/dev/null 2>&1 & disown
```
End your turn. **Pass:** you are woken saying the path `disappeared`.

---

## Test 5: cancel

1. Register a listener for `/tmp/perk-test-cancel` (ensure it does not exist),
   then immediately `perk_cancel({ id: <that id> })`.
2. Schedule its trigger, fully detached, and end your turn:

   ```bash
   nohup zsh -c 'sleep 20 && touch /tmp/perk-test-cancel' >/dev/null 2>&1 & disown
   ```

**Pass:** **no** wake arrives. **For the human:** after the agent goes idle,
wait ~25s (so the trigger fires), then send any short message. The silence is
the proof that cancel removed the listener.

---

## Cleanup

```bash
rm -f /tmp/perk-test-1 /tmp/perk-test-del /tmp/perk-test-cancel
```

Cancel any listeners you still have armed with `perk_cancel`.

---

## Known limitation to keep in mind

The watcher compares `{ exists, mtimeMs, size }`. A **same-mtime, same-size
overwrite** is invisible to it, so a content change that does not move mtime or
size can be missed. This is an accepted proof-of-concept tradeoff (a content
hash would close it at the cost of reading every watched file each poll). Do not
treat a missed same-stat overwrite as a bug.

## What a full pass demonstrates

- An afferent channel: the world produced a turn, not a human (Test 1).
- Deliberate attention via edge-trigger + ack (Tests 2, 3).
- Best-effort detection of appearance, change, and disappearance (Tests 1, 3, 4).
- Clean teardown (Test 5).

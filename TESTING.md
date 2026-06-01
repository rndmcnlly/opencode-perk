# Testing perk (from inside a perk-enabled agent)

This guide is written **for an agent** running in an opencode session where
`.opencode/plugin/perk.ts` is loaded. You exercise the plugin on yourself: arm
listeners, change files with your own `bash` tool, and observe yourself getting
woken. No external harness, no HTTP. Your conversation *is* the test rig.

perk has two surfaces, tested in turn below:

1. **The afferent channel** (`perk_register` / `perk_ack` / `perk_cancel`): watch
   a path, get a turn when it changes.
2. **`perk_bash_background`**: run a command as a fire-and-forget background job
   and be woken with its exit code and captured-output sizes.

## How to read this guide

This protocol **sets up the hoops and states what counts as passing. It does not
teach you how the tools work.** Read each tool's own description (and the wake /
return notices it emits) for that. This is deliberate: the docstrings are what we
are testing. If you find yourself unsure how to use a tool, that uncertainty is
itself a finding to report, not a gap for this file to paper over. Use the tools
as their own descriptions tell you to, and report anything that surprised you.

## Rig setup (facts about the test, not about the tools)

- Be in a **fresh opencode session**. Plugin tools only reach the model when the
  tool list is built; a stale session predating the plugin load may not offer the
  `perk_*` tools. If a tool seems inert in a confirmed-fresh session, check
  `/tmp/perk.log` for load errors before calling it a test failure.
- Use paths inside the project `.perk/` dir (e.g. `.perk/perk-test-1`). Avoid
  `/tmp` and other out-of-worktree paths: opencode prompts for permission on any
  access outside the project, which interrupts the unattended round-trip. Pick
  fresh paths that do not already exist; clean up at the end. (`.perk/` also holds
  the files `perk_bash_background` auto-generates.) Run `mkdir -p .perk` once
  before Part 1 so the scheduled `touch` triggers have a directory to write into.
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

> **Scheduling a delayed trigger:** for Part 1, schedule the delayed change with
> a **plain detached shell job via the builtin `bash` tool** that arms *no* perk
> listener, e.g.:
> ```bash
> (sleep 20; touch .perk/perk-test-1) >/dev/null 2>&1 &
> ```
> Do **not** use `perk_bash_background` as the trigger here. `perk_bash_background`
> arms its own one-shot listener on its sentinel and therefore emits its *own*
> completion wake. In Part 1 you are testing a *specific* listener; a second wake
> from the trigger job would be noise in the positive tests and a false-FAIL trap
> in the negative tests (2 and 5), whose pass criterion is *silence*. A plain
> backgrounded shell job is a silent side channel: it changes the file and reports
> nothing, so the only wake that can arrive is the one under test.
>
> (The `&`-backgrounded job returns the shell immediately, so the `bash` call does
> not block for the `sleep`. You then arm your listener and end your turn.)
> `perk_bash_background` gets its own dedicated coverage in Part 2.

---

# Part 1: the afferent channel

## Test 1: the core round-trip

The one that matters. Everything else is refinement.

1. `rm -f .perk/perk-test-1` (known state).
2. `perk_register` the path `.perk/perk-test-1`.
3. Schedule a delayed `touch .perk/perk-test-1` that outlives your turn (see the
   scheduling note: plain detached `bash` job, no perk listener).
4. **End your turn.** Say one short sentence ("Armed test 1; waiting.") and stop.
   Do not poll, loop, or call more tools. Going idle is the point.

**Pass:** a turn arrives on its own (no human typed it) reporting that the watched
path appeared. **Fail:** no turn ever arrives.

## Test 2: edge-trigger discipline (no re-fire without ack)

After Test 1 wakes you, change the file again **without acking**
(`echo more >> .perk/perk-test-1`), then end your turn.

**Pass:** **no** wake arrives; the disarmed listener ignored the change. (You sit
idle until a human speaks; that silence is success.)
**For the human:** after the agent goes idle, wait a couple of seconds, then send
any short message. No autonomous wake before your message is the proof.
**Note:** because the trigger is a plain `bash` job (no perk listener), nothing
but the listener-under-test can wake you, so the silence is clean. Do not use
`perk_bash_background` to schedule the change here, or its completion wake will
falsely break this test.

## Test 3: re-arming with ack

1. On a human-given turn, `perk_ack` the test-1 listener.
2. Schedule another delayed change to the same file (`echo again >> ...`).
3. End your turn.

**Pass:** you are woken again, reporting the path changed.

## Test 4: delete is detected too

`touch .perk/perk-test-del` (exists at arm time), `perk_register` it, schedule a
delayed `rm -f .perk/perk-test-del`, end your turn.

**Pass:** you are woken reporting the path disappeared.

## Test 5: cancel

`perk_register` `.perk/perk-test-cancel` (ensure it does not exist), immediately
`perk_cancel` that listener, then schedule its delayed trigger (plain `bash` job,
no perk listener) and end your turn.

**Pass:** **no** wake arrives. **For the human:** after the agent goes idle, wait
~25s (so the trigger fires), then send any short message. The silence proves
cancel removed the listener.
**Note:** as in Test 2, the trigger must be a plain backgrounded `bash` job. If
you schedule it with `perk_bash_background`, that job's own completion wake will
arrive and you will misread it as a FAIL.

---

# Part 2: `perk_bash_background`

## Test A: round-trip

1. Call `perk_bash_background` with `command` = `sleep 20; true` (no other args).
2. **End your turn.** One short sentence, then stop. Do not poll.

**Pass:** the call returns effectively instantly (it does not block for the
`sleep`), **and** a turn later arrives on its own reporting a clean exit. Both
halves must hold.

## Test B: nonzero exit

Call `perk_bash_background` with `command` = `sleep 20; exit 17`. End your turn.

**Pass:** you are woken on your own, and the wake reports exit code 17.

## Test C: captured output

Call `perk_bash_background` with a command that writes to both streams and exits
nonzero, e.g.:
```
echo hello on stdout
echo uh oh on stderr 1>&2
sleep 20
exit 3
```
End your turn.

**Pass:** the wake reports exit code 3 **and** nonzero byte sizes for both
stdout and stderr, with their `.perk/` paths. Reading the named files shows the
two lines. (The tool chose and reported the paths; you did not pass any.)

## Test D: explicit rendezvous (optional)

There is no `sentinel` argument: perk auto-generates its own private files. If
you want a public rendezvous file another observer can wait on, you write it
yourself in the command body. Call `perk_bash_background` with
`command` = `sleep 20; touch .perk/rendezvous-d.done`, and in a **separate, plain
`bash`** call block on that file:
`while [ ! -e .perk/rendezvous-d.done ]; do sleep 1; done; echo seen`

**Pass:** the second call eventually prints `seen`. (A perk wake for the job's
own completion also arrives; both observers are valid.)

---

## Cleanup

```bash
rm -f .perk/perk-test-1 .perk/perk-test-del .perk/perk-test-cancel \
      .perk/rendezvous-d.done
```

`perk_bash_background` also leaves per-job `.perk/job_*.{out,err,exit}` capture
files; remove them too (`rm -f .perk/job_*`) or just `rm -rf .perk` once no
listeners are armed. The whole `.perk/` dir is gitignored.

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
- Anything about `perk_bash_background` (its single `command` arg with no paths
  to choose; the command recorded verbatim in your own tool call, *not* echoed
  back in the wake; stdout/stderr/exit captured to `.perk/` files reported by
  size + path; the listener auto-removing on completion so no ack is needed; the
  immediate return) that read wrong?
- Any confusion about the fresh-session requirement?

## What a full pass demonstrates

- An afferent channel: the world produced a turn, not a human (Test 1).
- Deliberate attention via edge-trigger + ack (Tests 2, 3).
- Best-effort detection of appearance, change, disappearance (Tests 1, 3, 4).
- Clean teardown (Test 5).
- Fire-and-forget jobs that return immediately, capture their output, and report
  exit code + output sizes on their own (Tests A, B, C), with public rendezvous
  available by writing it yourself in the command body when rarely needed (Test
  D).

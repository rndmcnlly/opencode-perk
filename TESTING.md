# Testing perk (from inside a perk-enabled agent)

This guide is written **for an agent** running in an opencode session where
`.opencode/plugin/perk.ts` is loaded. You exercise the plugin on yourself: fire
background jobs with `perk_bash_background`, block on rendezvous files with your
own `bash`, and observe yourself getting woken. No external harness, no HTTP.
Your conversation *is* the test rig.

perk is **one tool**: `perk_bash_background`. It has two behaviors to verify:

1. **The afferent channel:** fire a job, end your turn, get woken on completion
   with the exit code and captured-output sizes (interactive).
2. **The foreground rendezvous:** block on the returned exit-file path in plain
   `bash` (the headless wait), and kill a running job via its pgid.

## How to read this guide

This protocol **sets up the hoops and states what counts as passing. It does not
teach you how the tool works.** Read the tool's own description (and the wake /
return notices it emits) for that. This is deliberate: the docstring is what we
are testing. If you find yourself unsure how to use the tool, that uncertainty
is itself a finding to report, not a gap for this file to paper over.

## Rig setup (facts about the test, not about the tool)

- Be in a **fresh opencode session**. Plugin tools only reach the model when the
  tool list is built; a stale session predating the plugin load may not offer
  `perk_bash_background`. If the tool seems inert in a confirmed-fresh session,
  check `/tmp/perk.log` for load errors before calling it a test failure.
- `perk_bash_background` auto-generates its capture files under the project
  `.perk/` dir; you never choose paths. For any *public* rendezvous file you
  create yourself, also use `.perk/` (e.g. `.perk/rendezvous-x.done`) to stay
  inside the worktree and avoid opencode's out-of-worktree permission prompt.
- **A job must outlast one of your turns** to test the wake. Per-turn latency
  (model thinking + tool round-trips) can be ~10s. Use **`sleep 20`** as the
  canonical delay: long enough that you genuinely go idle before it finishes.
- Plugin logs go to `/tmp/perk.log` (never the terminal: stderr would corrupt
  the TUI). `tail -f /tmp/perk.log` in another shell to watch `spawned` /
  `fired` / `dispose reap` events. `PERK_LOG=off` silences.

---

# Part 1: the afferent channel (interactive wake)

## Test 1: the core round-trip

The one that matters. Everything else is refinement.

1. Call `perk_bash_background` with `command` = `sleep 20; true` (no other args).
2. **End your turn.** Say one short sentence ("Fired test 1; waiting.") and stop.
   Do not poll, loop, or call more tools. Going idle is the point.

**Pass:** the call returns effectively instantly (it does **not** block for the
`sleep`), **and** a turn later arrives on its own (no human typed it) reporting a
clean exit. Both halves must hold. **Fail:** the call blocks, or no turn ever
arrives.

## Test 2: nonzero exit

Call `perk_bash_background` with `command` = `sleep 20; exit 17`. End your turn.

**Pass:** you are woken on your own, and the wake reports exit code 17.

## Test 3: captured output

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

---

# Part 2: the foreground rendezvous (the headless wait)

This is how you wait when you are headless (`opencode run`) and cannot rely on an
injected wake, because ending your turn would exit the process.

## Test 4: block on the exit file

1. Call `perk_bash_background` with `command` = `sleep 20; echo done-4`. Note the
   **exit-file path** it returns.
2. In a **separate, foreground `bash`** call, block on that path exactly as the
   tool advises:
   ```bash
   until [ -e <exit-file> ]; do sleep 0.3; done; echo UNBLOCKED; cat <out-file>
   ```

**Pass:** the `bash` call blocks (does not return immediately), then prints
`UNBLOCKED` followed by `done-4`. This proves the exit file appears only when the
job is truly finished and its output is already flushed. (A perk injection wake
for the same job may also arrive; both observers are valid.)

## Test 5: kill via pgid

1. Call `perk_bash_background` with `command` = `sleep 120`. Note the **pgid** it
   returns.
2. In a `bash` call, kill the whole group: `kill -TERM -<pgid>` (leading minus).
3. Verify it is gone: `ps -eo pid,command | grep "[s]leep 120" || echo REAPED`.

**Pass:** the kill succeeds and the check prints `REAPED` (no surviving
`sleep 120`). This proves the returned pgid is a working kill handle for the
whole job tree.

## Test 6: explicit public rendezvous (optional)

There is no rendezvous argument: perk auto-generates its own private files. If
you want a *public* file another observer can wait on, write it yourself in the
command body. Call `perk_bash_background` with
`command` = `sleep 20; touch .perk/rendezvous-6.done`, and in a **separate,
foreground `bash`** call block on it:
```bash
until [ -e .perk/rendezvous-6.done ]; do sleep 1; done; echo seen
```

**Pass:** the second call eventually prints `seen`. (A perk wake for the job's
own completion also arrives; both observers are valid.)

---

## Cleanup

```bash
rm -rf .perk      # removes all per-job capture files and any rendezvous files
```

The whole `.perk/` dir is gitignored. Kill any jobs you started and did not let
finish via `kill -TERM -<pgid>`.

---

## Report back on

- Did the tool's own description give you enough to use it correctly on the first
  try, or did something surprise you mid-test? **Name the surprise.** (This is
  the primary signal: the protocol withholds the mechanism on purpose.)
- Was the wake verdict (clean / exit code N; stdout/stderr byte sizes + paths)
  unambiguous?
- Was the interactive-vs-headless guidance (end your turn vs. foreground
  until-loop) clear from the tool's return value alone?
- Did the pgid kill handle work as described (the leading-minus group form)?
- Anything about `perk_bash_background` (its single `command` arg with no paths
  to choose; the command recorded verbatim in your own tool call, *not* echoed
  back in the wake; capture reported by size + path; the immediate return; the
  pgid) that read wrong?

## What a full pass demonstrates

- An afferent channel: the world (a finishing job) produced a turn, not a human
  (Tests 1, 2, 3).
- Fire-and-forget that returns immediately and reports exit code + output sizes
  on its own (Tests 1, 2, 3).
- A correct foreground completion gate on the rendezvous file: the headless wait
  with no plugin machinery (Tests 4, 6).
- A working kill handle for the whole job tree (Test 5).

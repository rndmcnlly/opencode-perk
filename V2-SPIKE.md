# OpenCode V2 progress-relay spike

This branch scouts the narrow role proposed in issue #7. OpenCode V2 owns shell
execution, persistence, restart behavior, and final completion notifications.
The spike only observes a native background shell's combined output and emits a
coalesced intermediate progress turn after one second of quiet.

This is a research snapshot, not the settled V2 product design. In the code on
this branch, every native shell tool call that enters the background-running
state is observed automatically. There is no per-call opt-in yet.

It was developed against OpenCode `v2.0.14` at commit
`ad756ef09bbe5af0dc5ce71e0c1cc37faccc496d`.

## Design

`src-v2/index.ts` correlates two V2 surfaces:

1. `shell.created` provides the native shell ID and capture-file path.
2. `tool.execute.after` identifies which native shell calls actually moved to
   the background and provides their Session ID.

`src-v2/relay.ts` tails only those correlated files. Bursts are coalesced after
a quiet interval and capped at 16 KiB per turn. Progress uses synthetic `steer`
delivery and resumes the Session. `shell.exited` stops observation without a
final flush because V2 core owns the authoritative completion notification.

The V1 runner, spool, cancellation, completion monitor, and `bash_background`
tool are intentionally not reused.

## Verify

```bash
npm install
npm run check:v2
npm run smoke:v2 -- /path/to/source-built/opencode
```

An end-to-end demonstration against local oMLX can be run with:

```bash
set -a; source "$HOME/.tokens/omlx-api"; set +a
npm run demo:v2 -- /path/to/source-built/opencode
```

The demonstration starts V2 with temporary HOME and XDG roots, loads only this
plugin, runs a staged native background shell, and writes the projected session
to `V2-LIVE-TRANSCRIPT.json`. The checked-in transcript records two perk
progress wakeups followed by V2 core's authoritative completion wakeup.

For a local V2 source checkout, put a symlink to this branch's `src-v2`
directory under an isolated test project's `.opencode/plugins/` directory.
Do not install this spike globally alongside a working V1 setup.

## Known unstable seams

- V2 does not expose shell output through Effect plugin context, so the spike
  reads the core-owned `Shell.Info.file` directly.
- Background detection relies on the native shell tool's current result
  metadata fields: `status: "running"` and `shellID`.
- Shell lifecycle events are ephemeral. Reloading the plugin cannot rediscover
  already-running shells because plugin context has no `shell.list` operation.
- Each progress turn is durable model input. Coalescing and the 16 KiB cap limit
  transcript growth, but do not eliminate it.
- Core completion can race with a progress admission already in flight. The
  relay checks that a spike is still active immediately before admission, but
  the current plugin API offers no atomic "admit only while shell is running"
  operation.

The target upstream primitive remains a read-only cursor API such as
`ctx.shell.output({ shellID, cursor, limit })`, ideally with list/get/wait or an
incremental output event. Once that exists, `relay.ts` can retain its temporal
coalescing policy while dropping direct filesystem access.

## Design after the spike

The experiment clarified a smaller likely product surface that is not yet
implemented on this branch:

1. Extend the native shell tool object with `progress: true`; absent that field,
   perk ignores the job.
2. Never rewrite the command text. The agent intentionally shapes familiar
   stdout and redirection so useful checkpoints appear in captured output.
3. Retain a short quiet-gap coalescer, but permit at most one outstanding perk
   steer per Session. Additional output accumulates in one bounded buffer.
4. Treat `session.inbox.delivered` for perk's synthetic message ID as flow-control
   credit, then admit one combined buffered update for a later steering boundary.

This one-slot, receiver-paced mailbox matters for long-lived control loops that
may never become idle. A fast agent reaches steering boundaries frequently and
gets finer-grained progress. A slow local model cannot accumulate an unbounded
queue of stale timer buckets. Exact inclusion of all bytes arriving before the
current steering boundary would require mutable pending inbox items, which the
public plugin API does not expose; the one-slot design accepts one boundary of
latency instead.

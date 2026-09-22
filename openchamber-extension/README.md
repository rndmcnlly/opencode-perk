# OpenChamber background-jobs panel

This is a local companion to `opencode-perk`. It shows jobs from the conversation
currently open in OpenChamber. Perk remains responsible for job execution and
completion messages.

The service and panel share `src/protocol.ts` with the plugin. New launch
records use schema 2 and millisecond durations. Legacy schema-1 records remain
visible; their estimates are converted from seconds and absent deadlines remain
unspecified. Timeout, cancellation, and shutdown are distinct terminal outcomes.

Running jobs can be cancelled from the panel. The service records a cancellation
request in the private spool; only the perk runtime that owns the job may signal
its process group. Cards can be collapsed and expanded without losing them; the
status, elapsed time, and task summary remain visible, and collapsed state is
saved per conversation in OpenChamber storage. Expand a card's **Details**
disclosure for identifiers, timestamps, and sidecar paths.

The **Live output** disclosure incrementally follows stdout, stderr, or progress
while it is open. Reads are session-scoped and bounded; closing the disclosure
stops polling, and no output is injected into the conversation.

Build it from the repository root:

```bash
npm run build:extension
```

For visual design work, run the exact panel renderer against evolving mock jobs:

```bash
npm run dev:extension
```

Then open <http://localhost:4173/panel/?mock=1>. The fixture includes running,
successful, failed, collapsed, long-command, and long-output states. One job
finishes after about 20 seconds; refresh the page to restart its timeline. Edit
`panel/styles.css` for visual design: changes appear on refresh, while esbuild
rebuilds TypeScript changes on request. No OpenChamber restart is needed.

Then add this directory in **OpenChamber Settings -> Extensions**:

```text
/Users/adam/Desktop/opencode-perk/openchamber-extension
```

OpenChamber will ask permission to run the bundled local service. The service
only accesses the private perk spool under `os.tmpdir()/opencode/perk/` and
exposes session-matching job records to its sandboxed panel.

For local plugin development, load `src/index.ts` through
`.opencode/plugin/perk.ts` and start a fresh session after plugin changes.

# OpenChamber background-jobs panel

This is a local companion to `opencode-perk`. It shows jobs from the conversation
currently open in OpenChamber. Perk remains responsible for job execution and
completion messages.

Running jobs can be cancelled from the panel. The service records a cancellation
request in the private spool; only the perk runtime that owns the job may signal
its process group. Dismissing a completed card affects only this extension's
OpenChamber storage. Expand a card's **Details** disclosure for its command,
identifiers, timestamps, and sidecar paths.

The **Live output** disclosure incrementally follows stdout, stderr, or progress
while it is open. Reads are session-scoped and bounded; closing the disclosure
stops polling, and no output is injected into the conversation.

Build it from the repository root:

```bash
npm run build:extension
```

Then add this directory in **OpenChamber Settings -> Extensions**:

```text
/Users/adam/Desktop/opencode-perk/openchamber-extension
```

OpenChamber will ask permission to run the bundled local service. The service
only accesses the private perk spool under `os.tmpdir()/opencode/perk/` and
exposes session-matching job records to its sandboxed panel.

For local plugin development, load `src/index.ts` through
`.opencode/plugin/perk.ts` and start a fresh session after plugin changes.

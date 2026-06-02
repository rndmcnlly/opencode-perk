# AGENTS.md

## What this is

`opencode-perk` is an opencode plugin published to npm. It adds one tool,
`bash_background({ command })`, that runs a shell command as a detached
fire-and-forget job and returns immediately. When the job finishes, perk injects
a conversational turn into the idle session reporting the exit code and the byte
sizes of captured stdout/stderr. It is the *afferent channel* for a harnessed
model: the world, not just the human, can produce the next turn.

See `README.md` for the concept and `TESTING.md` for the self-test protocol.

## File layout

```
src/index.ts     The entire implementation (single file, fully commented).
dist/            tsc build output. Gitignored; built on publish.
README.md        Conceptual doc + install instructions.
TESTING.md       Manual, agent-driven self-test protocol.
package.json     Package metadata and scripts.
tsconfig.json    ES2022 / ESNext / Bundler resolution, emits declarations.
.perk/           Runtime scratch dir for job capture files. Gitignored.
.opencode/       Opt-in self-demo symlink dir (see below). Gitignored.
```

Keep the implementation in the single file `src/index.ts`. There is no runtime
dependency beyond Node built-ins plus the peer `@opencode-ai/plugin`.

## The npm package

- Name `opencode-perk`, ESM (`"type": "module"`), zero runtime dependencies.
- `main` / `types` / `exports` all point into `dist/`. The `files` field
  publishes only `dist`, `README.md`, `LICENSE`.
- No `bin`: this is a plugin/library consumed by opencode, not a CLI.
- Exports both named `Perk` and `export default Perk` to hedge against loader
  iteration order.

Scripts:

```
npm run build    tsc -p tsconfig.json
npm run clean    rm -rf dist
prepublishOnly   clean + build (runs automatically on npm publish)
```

## Testing route

There is **no automated test framework and no `test` script**. Testing is a
manual self-test the agent performs against a live opencode session, following
`TESTING.md` ("your conversation *is* the test rig").

To arm the plugin in this repo so opencode loads it:

```bash
npm install
mkdir -p .opencode/plugin
ln -s ../../src/index.ts .opencode/plugin/perk.ts
```

opencode auto-loads `.opencode/plugin/`, so `bash_background` goes live here.
Remove `.opencode/` to disarm; the repo does not load perk on itself by default.

Then point an agent at `TESTING.md` and run the six tests (interactive wake and
foreground rendezvous). Build verification is just `npm run build`. Runtime logs
for debugging go to `/tmp/perk.log` (set `PERK_LOG=off` to silence; perk never
writes stdout/stderr, which would corrupt the TUI). Clean up with `rm -rf .perk`.

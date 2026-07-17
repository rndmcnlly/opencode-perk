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
os.tmpdir()/opencode/perk/  Runtime spool; one private directory per job.
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

Publishing: the agent should NOT run `npm publish`. The npm account has 2FA, so
publish needs a one-time password (the CLI errors with `EOTP` mid-publish and an
agent cannot complete the browser auth flow). The version bump, commit, and push
are fine for the agent to do; Adam runs `npm publish` himself afterward so the
browser auth flow can complete.

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

Then point an agent at `TESTING.md` and run the tests. Build verification is
just `npm run build`. Runtime logging is off by default; `PERK_LOG=1` writes to
the spool's `log` file. perk never writes stdout/stderr, which would corrupt the
TUI. Completed job directories expire after 24 hours.

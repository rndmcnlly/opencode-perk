import { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { ProgressRelay } from "./relay.js"

const POLL_MS = 250

export default Plugin.define({
  id: "opencode-perk-v2-spike",
  effect: Effect.fn("PerkV2Spike")(function* (ctx) {
    const relay = new ProgressRelay()

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "shell.created") {
            relay.created(event.data.info)
            return
          }
          if (event.type === "shell.exited" || event.type === "shell.deleted") relay.exited(event.data.id)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.sync(() => {
        if (event.tool !== "shell" || event.status !== "completed") return
        if (event.result.metadata?.status !== "running") return
        const shellID = event.result.metadata.shellID
        if (typeof shellID !== "string") return
        relay.background(shellID, event.sessionID, commandOf(event.input))
      }),
    )

    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(POLL_MS)
        const spikes = relay.tick()
        yield* Effect.forEach(
          spikes,
          (spike) => {
            if (!relay.deliverable(spike)) return Effect.void
            return ctx.session
              .synthetic({
                sessionID: spike.sessionID,
                text: `Progress from shell ${spike.shellID}:\n${spike.text}`,
                description: spike.command,
                metadata: {
                  source: "opencode-perk-v2-spike",
                  shellID: spike.shellID,
                  state: "running",
                  cursor: spike.cursor,
                },
                delivery: "steer",
                resume: true,
              })
              .pipe(
                Effect.tap(() => Effect.sync(() => relay.acknowledge(spike))),
                Effect.catchCause((cause) =>
                  Effect.sync(() => relay.retry(spike)).pipe(
                    Effect.andThen(Effect.logWarning("perk progress delivery failed", cause)),
                  ),
                ),
              )
          },
          { discard: true },
        )
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})

function commandOf(input: unknown) {
  if (typeof input !== "object" || input === null || !("command" in input)) return "Background shell progress"
  return typeof input.command === "string" ? input.command : "Background shell progress"
}

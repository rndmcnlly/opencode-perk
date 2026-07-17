import { readFileSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { fileState, readRange, size } from "./spool.js"

export type Listener = {
  inject: Injector
  sessionID: string
  id: string
  exit: string
  out: string
  err: string
  drip: string
  pgid: number
  dripOffset: number
  dripSeen: number
  dripIdentity: string
  dripDecoder: StringDecoder
}

export type Injector = (sessionID: string, message: string) => Promise<void>
type Fired = { inject: Injector; sessionID: string; message: string }
type Logger = (...values: unknown[]) => void

export class Monitor {
  readonly listeners = new Map<string, Listener>()
  private delivery = Promise.resolve()

  constructor(private readonly logger: Logger = () => {}) {}

  add(listener: Omit<Listener, "dripDecoder">) {
    this.listeners.set(listener.id, {
      ...listener,
      dripDecoder: new StringDecoder("utf8"),
    })
  }

  clear() {
    this.listeners.clear()
  }

  // One deterministic observation pass. Production supplies the interval;
  // tests call this directly to model growth, quiet windows, and completion.
  tick() {
    const fired: Fired[] = []

    for (const listener of this.listeners.values()) {
      const currentDrip = fileState(listener.drip)
      const dripSize = currentDrip?.size ?? 0
      if (
        currentDrip &&
        (currentDrip.identity !== listener.dripIdentity ||
          dripSize < listener.dripOffset)
      ) {
        this.resetDrip(listener, currentDrip.identity)
        fired.push(this.replacementEvent(listener))
      }

      if (dripSize > listener.dripSeen) {
        listener.dripSeen = dripSize
      } else if (dripSize > listener.dripOffset) {
        const bytes = readRange(listener.drip, listener.dripOffset, dripSize)
        listener.dripOffset += bytes.length
        const chunk = listener.dripDecoder.write(bytes)
        if (chunk.trim().length > 0) {
          this.logger("spike", { pgid: listener.pgid, bytes: bytes.length })
          fired.push({
            inject: listener.inject,
            sessionID: listener.sessionID,
            message: `Spike from job ${listener.id}:\n${chunk.trimEnd()}`,
          })
        }
      }

      let code: string
      try {
        code = readFileSync(listener.exit, "utf8").trim() || "?"
      } catch {
        continue
      }

      const finalState = fileState(listener.drip)
      if (
        finalState &&
        (finalState.identity !== listener.dripIdentity ||
          finalState.size < listener.dripOffset)
      ) {
        this.resetDrip(listener, finalState.identity)
        fired.push(this.replacementEvent(listener))
      }

      const finalSize = finalState?.size ?? 0
      const finalBytes = readRange(
        listener.drip,
        listener.dripOffset,
        finalSize,
      )
      listener.dripOffset += finalBytes.length
      if (listener.dripOffset < finalSize) continue

      const finalDrip =
        listener.dripDecoder.write(finalBytes) + listener.dripDecoder.end()
      if (finalDrip.trim().length > 0) {
        this.logger("spike (final)", {
          pgid: listener.pgid,
          bytes: finalBytes.length,
        })
        fired.push({
          inject: listener.inject,
          sessionID: listener.sessionID,
          message: `Spike from job ${listener.id}:\n${finalDrip.trimEnd()}`,
        })
      }

      const outcome = code.startsWith("cancelled:")
        ? `cancelled by ${code.slice("cancelled:".length) || "signal"}`
        : `exited ${code}`
      fired.push({
        inject: listener.inject,
        sessionID: listener.sessionID,
        message:
          `Job ${listener.id} ${outcome}: ` +
          `out ${size(listener.out)} bytes, err ${size(listener.err)} bytes`,
      })
      this.logger("fired", { pgid: listener.pgid, code })
      this.listeners.delete(listener.id)
    }

    if (fired.length === 0) return
    // Every tick joins one delivery chain, preserving transcript order even if
    // promptAsync is slower than the polling interval.
    this.delivery = this.delivery.then(async () => {
      for (const event of fired) {
        await event.inject(event.sessionID, event.message).catch((error) =>
          this.logger("inject failed", { error: String(error) }),
        )
      }
    })
  }

  async settled() {
    await this.delivery
  }

  private resetDrip(listener: Listener, identity: string) {
    listener.dripIdentity = identity
    listener.dripOffset = 0
    listener.dripSeen = 0
    listener.dripDecoder = new StringDecoder("utf8")
  }

  private replacementEvent(listener: Listener): Fired {
    return {
      inject: listener.inject,
      sessionID: listener.sessionID,
      message:
        `Spike from job ${listener.id}:\n` +
        `[perk: drip file was truncated or replaced; decoding restarted]`,
    }
  }
}

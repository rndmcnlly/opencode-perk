import { spawn } from "node:child_process"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import type { JobFiles } from "./spool.js"

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// The shell reports only its result. The supervisor alone publishes exit, after
// any requested process-group termination has finished.
export function backgroundScript(command: string, files: JobFiles): string {
  return [
    "umask 077",
    "__perk_finish() {",
    "  trap '' HUP INT TERM",
    `  printf '%s\\n' "$1" > ${shSingleQuote(files.result + ".tmp")}`,
    `  mv ${shSingleQuote(files.result + ".tmp")} ${shSingleQuote(files.result)}`,
    "}",
    `trap '__perk_finish "cancelled:HUP"; exit 129' HUP`,
    `trap '__perk_finish "cancelled:INT"; exit 130' INT`,
    `trap '__perk_finish "cancelled:TERM"; exit 143' TERM`,
    `export PERK_DRIP=${shSingleQuote(files.drip)}`,
    "(",
    "set -e",
    command,
    `) >${shSingleQuote(files.out)} 2>${shSingleQuote(files.err)}`,
    "__perk_code=$?",
    `__perk_finish "$__perk_code"`,
  ].join("\n")
}

export function spawnBackground(
  command: string,
  files: JobFiles,
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", backgroundScript(command, files)], {
      cwd,
      detached: true,
      stdio: "ignore",
    })
    child.once("spawn", () => {
      child.unref()
      resolve(child.pid!)
    })
    child.once("error", reject)
  })
}

export function killJob(pgid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch {
    return false
  }
}

export const TERMINATION_GRACE_MS = 1_000
export type StopReason = "cancelled" | "timeout" | "shutdown"
export interface JobControl {
  readonly finished: boolean
  observe(now: number): void
  requestStop(reason: StopReason, now: number): void
}

type Lifecycle =
  | { phase: "running" }
  | { phase: "stopping"; outcome: string; requestedAt: number }
  | { phase: "finished" }

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    // Darwin can briefly report EPERM for a dying group. It is not evidence
    // that the group has disappeared; wait for ESRCH on a subsequent pass.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    throw error
  }
}

export class ManagedJob implements JobControl {
  private state: Lifecycle = { phase: "running" }

  constructor(readonly pgid: number, private readonly files: JobFiles) {}

  get finished() { return this.state.phase === "finished" }

  requestStop(reason: StopReason, now: number) {
    // A result already published by the shell wins over a late stop request.
    this.observe(now)
    if (this.state.phase !== "running") return
    this.state = {
      phase: "stopping", requestedAt: now,
      outcome: reason === "cancelled" ? "cancelled:TERM" : reason,
    }
    killJob(this.pgid)
  }

  observe(now: number) {
    if (this.state.phase === "finished") return
    if (this.state.phase === "stopping") {
      // Even if the wrapper exits on TERM, a descendant may have ignored it.
      if (!groupExists(this.pgid)) {
        this.publish(this.state.outcome)
      } else if (now - this.state.requestedAt >= TERMINATION_GRACE_MS) {
        // Retry while the group exists, including a child fork racing a signal.
        killJob(this.pgid, "SIGKILL")
      }
      return
    }

    let result = this.readResult()
    if (result === undefined && !groupExists(this.pgid)) {
      // The wrapper may have published between the first read and the probe.
      result = this.readResult() ?? "cancelled:unknown"
    }
    if (result?.startsWith("cancelled:")) {
      this.state = {
        phase: "stopping", outcome: result, requestedAt: now,
      }
      killJob(this.pgid)
    } else if (result !== undefined) this.publish(result)
  }

  private readResult(): string | undefined {
    try {
      return readFileSync(this.files.result, "utf8").trim() || "?"
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return undefined
    }
  }

  private publish(outcome: string) {
    // One publisher, one atomic completion gate. The shell never writes here.
    writeFileSync(`${this.files.exit}.tmp`, `${outcome}\n`, { mode: 0o600 })
    renameSync(`${this.files.exit}.tmp`, this.files.exit)
    this.state = { phase: "finished" }
  }
}

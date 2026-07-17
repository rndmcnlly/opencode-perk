import { appendFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { ensureSpoolDir, SPOOL_DIR } from "./spool.js"

const setting = process.env.PERK_LOG
const path =
  !setting || setting === "off"
    ? ""
    : setting === "1"
      ? join(SPOOL_DIR, "log")
      : setting

// Never write to stdout/stderr: the opencode TUI owns that surface.
export function log(...values: unknown[]) {
  if (!path) return
  try {
    if (setting === "1") ensureSpoolDir()
    const line = values
      .map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      )
      .join(" ")
    appendFileSync(path, `${new Date().toISOString()} [perk] ${line}\n`, {
      mode: 0o600,
    })
    chmodSync(path, 0o600)
  } catch {
    // Logging must never break the channel.
  }
}

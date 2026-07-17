import { spawn } from "node:child_process"
import type { JobFiles } from "./spool.js"

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// The user command gets its own line so a trailing shell comment cannot swallow
// the closing subshell. The exit marker is published last via atomic rename.
export function backgroundScript(command: string, files: JobFiles): string {
  return [
    "umask 077",
    "__perk_finish() {",
    "  trap '' HUP INT TERM",
    `  printf '%s\\n' "$1" > ${shSingleQuote(files.exit + ".tmp")}`,
    `  mv ${shSingleQuote(files.exit + ".tmp")} ${shSingleQuote(files.exit)}`,
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

export function killJob(pgid: number): boolean {
  try {
    process.kill(-pgid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const OPENCODE_TMP_DIR = join(tmpdir(), "opencode")
export const SPOOL_DIR = join(OPENCODE_TMP_DIR, "perk")

export type FileState = { size: number; identity: string }

export type JobFiles = {
  id: string
  dir: string
  exit: string
  out: string
  err: string
  drip: string
  dripIdentity: string
}

export function size(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function fileState(path: string): FileState | null {
  try {
    const stat = statSync(path)
    return { size: stat.size, identity: `${stat.dev}:${stat.ino}` }
  } catch {
    return null
  }
}

// The caller advances its cursor by the returned byte count, so a short read
// cannot silently discard drip data.
export function readRange(path: string, from: number, to: number): Buffer {
  const len = to - from
  if (len <= 0) return Buffer.alloc(0)
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const buf = Buffer.allocUnsafe(len)
    let n = 0
    while (n < len) {
      const read = readSync(fd, buf, n, len - n, from + n)
      if (read === 0) break
      n += read
    }
    return buf.subarray(0, n)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // A close failure must not stop monitoring.
      }
    }
  }
}

function ensurePrivateDirectory(
  path: string,
  label: string,
  normalizeMode: boolean,
) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Unsafe ${label} path: ${path}`)
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user: ${path}`)
  }
  if (normalizeMode) chmodSync(path, 0o700)
}

export function ensureSpoolDir(
  opencodeTmpDir = OPENCODE_TMP_DIR,
  spoolDir = SPOOL_DIR,
) {
  ensurePrivateDirectory(opencodeTmpDir, "opencode temporary", false)
  ensurePrivateDirectory(spoolDir, "perk spool", true)
}

export function makeJobFiles(spoolDir = SPOOL_DIR): JobFiles {
  if (spoolDir === SPOOL_DIR) ensureSpoolDir()
  else ensurePrivateDirectory(spoolDir, "perk spool", true)

  for (;;) {
    const id = randomBytes(4).toString("hex")
    const dir = join(spoolDir, id)
    try {
      mkdirSync(dir, { mode: 0o700 })
      const drip = join(dir, "drip")
      closeSync(openSync(drip, "wx", 0o600))
      return {
        id,
        dir,
        exit: join(dir, "exit"),
        out: join(dir, "out"),
        err: join(dir, "err"),
        drip,
        dripIdentity: fileState(drip)!.identity,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }
}

export const RETENTION_MS = 24 * 60 * 60 * 1000
export const SWEEP_MS = 60 * 60 * 1000

export function sweepCompletedJobs(
  spoolDir = SPOOL_DIR,
  now = Date.now(),
  onSweep: (id: string) => void = () => {},
) {
  const cutoff = now - RETENTION_MS
  let entries
  try {
    entries = readdirSync(spoolDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}$/.test(entry.name)) continue
    const dir = join(spoolDir, entry.name)
    try {
      if (statSync(join(dir, "exit")).mtimeMs >= cutoff) continue
      rmSync(dir, { recursive: true, force: true })
      onSweep(entry.name)
    } catch {
      // No readable exit means active or abandoned: never guess and delete it.
    }
  }
}

import { rmSync } from "node:fs"
import { killJob, spawnBackground } from "./job.js"
import { log } from "./log.js"
import { Monitor, type Injector } from "./monitor.js"
import {
  makeJobFiles,
  SPOOL_DIR,
  sweepCompletedJobs,
  SWEEP_MS,
} from "./spool.js"

export const POLL_MS = 300

export type JobHandle = { id: string; dir: string; pgid: number }

export class PerkRuntime {
  readonly monitor = new Monitor(log)
  private pollTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private disposed = false

  start() {
    this.disposed = false
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.monitor.tick(), POLL_MS)
      this.pollTimer.unref()
    }
    if (!this.sweepTimer) {
      this.sweep()
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS)
      this.sweepTimer.unref()
    }
  }

  async launch(
    command: string,
    cwd: string,
    sessionID: string,
    inject: Injector,
  ): Promise<JobHandle> {
    if (this.disposed) throw new Error("perk runtime is disposed")
    const files = makeJobFiles()
    let pgid: number
    try {
      pgid = await spawnBackground(command, files, cwd)
    } catch (error) {
      rmSync(files.dir, { recursive: true, force: true })
      throw error
    }

    // Disposal can run while the detached child is reaching its spawn event.
    // Reap it here rather than registering it into a stopped monitor.
    if (this.disposed) {
      killJob(pgid)
      throw new Error("perk runtime was disposed while launching the job")
    }

    this.monitor.add({
      inject,
      sessionID,
      id: files.id,
      exit: files.exit,
      out: files.out,
      err: files.err,
      drip: files.drip,
      pgid,
      dripOffset: 0,
      dripSeen: 0,
      dripIdentity: files.dripIdentity,
    })
    log("bash_background: spawned", { id: files.id, pgid, dir: files.dir, cwd })
    return { id: files.id, dir: files.dir, pgid }
  }

  async dispose() {
    this.disposed = true
    for (const listener of this.monitor.listeners.values()) {
      const ok = killJob(listener.pgid)
      log("dispose reap", { id: listener.id, pgid: listener.pgid, ok })
    }
    this.monitor.clear()
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.pollTimer = null
    this.sweepTimer = null
    await this.monitor.settled()
  }

  private sweep() {
    sweepCompletedJobs(SPOOL_DIR, Date.now(), (id) => log("swept", { id }))
  }
}

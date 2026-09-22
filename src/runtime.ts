import { rmSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { ManagedJob, spawnBackground, type JobControl } from "./job.js"
import { DEFAULT_TIMEOUT_MS, DEFAULT_COALESCE_MS, MIN_COALESCE_MS } from "./protocol.js"
import { log } from "./log.js"
import { Monitor, type Injector } from "./monitor.js"
import {
  makeJobFiles,
  SPOOL_DIR,
  sweepCompletedJobs,
  SWEEP_MS,
  writeLaunchRecord,
} from "./spool.js"

export const POLL_MS = 300

export type JobHandle = { id: string; dir: string; pgid: number }
type LaunchOptions = {
  command: string
  cwd: string
  sessionID: string
  inject: Injector
  timeoutMs?: number
  label?: string
  expectedMs?: number
  coalesceMs?: number
}

export class PerkRuntime {
  readonly monitor = new Monitor(log)
  private pollTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private disposed = false
  private launches = new Set<Promise<JobHandle>>()

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

  launch(options: LaunchOptions): Promise<JobHandle> {
    const pending = this.launchJob(options)
    this.launches.add(pending)
    void pending.then(
      () => this.launches.delete(pending),
      () => this.launches.delete(pending),
    )
    return pending
  }

  private async launchJob(options: LaunchOptions): Promise<JobHandle> {
    const {
      command,
      cwd,
      sessionID,
      inject,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      label,
      expectedMs,
      coalesceMs = DEFAULT_COALESCE_MS,
    } = options
    if (this.disposed) throw new Error("perk runtime is disposed")
    const files = makeJobFiles()
    const startedAt = new Date().toISOString()
    const startedMono = performance.now()
    let control: ManagedJob | undefined
    try {
      const pgid = await spawnBackground(command, files, cwd)
      control = new ManagedJob(pgid, files)
      writeLaunchRecord(files.launch, {
        schema: 2,
        id: files.id,
        sessionId: sessionID,
        ...(label === undefined ? {} : { label }),
        command,
        cwd,
        pgid,
        startedAt,
        timeoutMs,
        ...(expectedMs === undefined ? {} : { expectedMs }),
      })
    } catch (error) {
      if (control) await this.stopAndWait(control)
      rmSync(files.dir, { recursive: true, force: true })
      throw error
    }

    // Disposal can run while the detached child is reaching its spawn event.
    // Reap it here rather than registering it into a stopped monitor.
    if (this.disposed) {
      await this.stopAndWait(control)
      throw new Error("perk runtime was disposed while launching the job")
    }

    const pgid = control.pgid

    this.monitor.add({
      inject,
      sessionID,
      id: files.id,
      exit: files.exit,
      out: files.out,
      err: files.err,
      drip: files.drip,
      cancelPath: files.cancel,
      control,
      timeoutMs,
      deadline: startedMono + timeoutMs,
      pgid,
      dripOffset: 0,
      dripSeen: 0,
      dripIdentity: files.dripIdentity,
      dripChangedAt: null,
      quietMs: Math.max(coalesceMs, MIN_COALESCE_MS),
    })
    log("bash_background: spawned", { id: files.id, pgid, dir: files.dir, cwd })
    return { id: files.id, dir: files.dir, pgid }
  }

  async dispose() {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.pollTimer = null
    this.sweepTimer = null
    await Promise.all([
      ...[...this.monitor.listeners.values()].map(({ control }) => this.stopAndWait(control)),
      ...[...this.launches].map((launch) => launch.catch(() => {})),
    ])
    this.monitor.clear()
    await this.monitor.settled()
  }

  private async stopAndWait(control: JobControl) {
    control.requestStop("shutdown", performance.now())
    while (!control.finished) {
      await delay(20)
      control.observe(performance.now())
    }
  }

  private sweep() {
    sweepCompletedJobs(SPOOL_DIR, Date.now(), (id) => log("swept", { id }))
  }
}

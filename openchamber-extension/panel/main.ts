import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { describeOutcome, type VisibleJob } from "../../src/protocol.js"

type OutputStream = "stdout" | "stderr" | "progress"

type OutputChunk = {
  identity: string | null
  offset: number
  nextOffset: number
  size: number
  data: string
  complete: boolean
  reset: boolean
}

type StreamState = {
  offset: number
  identity: string | null
  text: string
  decoder: TextDecoder
  loading: boolean
  complete: boolean
  followTail: boolean
  scrollTop: number
  element: HTMLPreElement | null
  error: string | null
}

const host = connectHost()
const jobsRoot = document.querySelector<HTMLDivElement>("#jobs")!
const message = document.querySelector<HTMLDivElement>("#message")!
const notice = document.querySelector<HTMLDivElement>("#notice")!
let sessionId: string | null = null
let requestGeneration = 0
let jobs: VisibleJob[] = []
let dismissalsReady = false
let dismissed = new Set<string>()
let expanded = new Set<string>()
let selectedOutput = new Map<string, OutputStream>()
let streamStates = new Map<string, StreamState>()
let programScroll = new Map<string, { top: number; left: number }>()
let confirmStop: { id: string; until: number } | null = null
const MAX_OUTPUT_CHARS = 256 * 1024

function duration(startedAt: string, finishedAt?: string): number {
  const end = finishedAt ? Date.parse(finishedAt) : Date.now()
  return Math.max(0, end - Date.parse(startedAt))
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function status(job: VisibleJob): { label: string; tone: string } {
  if (job.state === "running" && job.cancellationRequested) {
    return { label: "Stopping", tone: "running" }
  }
  if (job.state === "running") return { label: "Running", tone: "running" }
  const outcome = describeOutcome(job.outcome ?? "?", job.timeoutMs)
  return {
    label: outcome[0].toUpperCase() + outcome.slice(1),
    tone: job.outcome === "0" ? "success" : "failure",
  }
}

function textElement(tag: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function storageKey(id: string): string {
  return `dismissed:${id}`
}

async function saveDismissed() {
  if (!sessionId) return
  await host.storage.set(storageKey(sessionId), [...dismissed])
}

function showNotice(text: string) {
  notice.textContent = text
  notice.style.display = text ? "block" : "none"
}

function detailRow(list: HTMLDListElement, term: string, value: string) {
  list.append(textElement("dt", "", term), textElement("dd", "", value))
}

function streamKey(jobId: string, stream: OutputStream): string {
  return `${jobId}:${stream}`
}

function streamState(jobId: string, stream: OutputStream): StreamState {
  const key = streamKey(jobId, stream)
  let state = streamStates.get(key)
  if (!state) {
    state = {
      offset: 0,
      identity: null,
      text: "",
      decoder: new TextDecoder(),
      loading: false,
      complete: false,
      followTail: true,
      scrollTop: 0,
      element: null,
      error: null,
    }
    streamStates.set(key, state)
  }
  return state
}

function paintOutput(state: StreamState) {
  const element = state.element
  if (!element) return
  element.textContent = state.error
    ? `Could not read output: ${state.error}`
    : state.text || (state.complete ? "(no output)" : "Waiting for output...")
  requestAnimationFrame(() => {
    if (state.element !== element) return
    if (state.followTail) element.scrollTop = element.scrollHeight
    else element.scrollTop = state.scrollTop
  })
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function refreshOutput(jobId: string, stream: OutputStream) {
  const currentSession = sessionId
  const state = streamState(jobId, stream)
  if (!currentSession || state.loading || state.complete) return
  state.loading = true
  try {
    const response = await host.serviceRequest({
      method: "GET",
      path: `/jobs/${jobId}/output/${stream}`,
      query: { session: currentSession, offset: String(state.offset) },
    })
    if (currentSession !== sessionId) return
    if (response.status !== 200) throw new Error(`Service answered ${response.status}`)
    const chunk = JSON.parse(response.body) as OutputChunk
    if (
      chunk.reset ||
      (state.identity !== null && chunk.identity !== null && state.identity !== chunk.identity)
    ) {
      state.offset = 0
      state.text = ""
      state.decoder = new TextDecoder()
      state.complete = false
      state.identity = chunk.identity
      return
    }
    state.identity = chunk.identity
    if (chunk.offset !== state.offset) {
      state.offset = 0
      state.text = ""
      state.decoder = new TextDecoder()
      return
    }
    const decoded = state.decoder.decode(decodeBase64(chunk.data), {
      stream: !chunk.complete,
    })
    state.text += decoded
    if (state.text.length > MAX_OUTPUT_CHARS) {
      state.text = `[older output omitted]\n${state.text.slice(-MAX_OUTPUT_CHARS)}`
    }
    state.offset = chunk.nextOffset
    state.complete = chunk.complete
    state.error = null
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    state.loading = false
    paintOutput(state)
  }
}

function render() {
  jobsRoot.replaceChildren()
  const shown = jobs.filter((job) => !dismissed.has(job.id))
  message.hidden = shown.length > 0
  message.textContent = jobs.length
    ? "All completed jobs in this conversation are dismissed."
    : "No background jobs in this conversation."

  for (const job of shown) {
    const state = status(job)
    const card = document.createElement("article")
    card.className = `job ${state.tone}`
    const label = document.createElement("div")
    label.className = "label"
    label.append(textElement("span", "job-id", job.id))
    if (job.label) label.append(document.createTextNode(`: ${job.label}`))
    card.append(label)
    const program = document.createElement("pre")
    program.className = "program"
    program.textContent = job.command
    const savedProgramScroll = programScroll.get(job.id) ?? { top: 0, left: 0 }
    program.addEventListener("scroll", () => {
      programScroll.set(job.id, {
        top: program.scrollTop,
        left: program.scrollLeft,
      })
    })
    card.append(program)
    requestAnimationFrame(() => {
      program.scrollTop = savedProgramScroll.top
      program.scrollLeft = savedProgramScroll.left
    })
    const details = document.createElement("div")
    details.className = "details"
    const stateLabel = document.createElement("span")
    stateLabel.className = "state"
    stateLabel.textContent = state.label
    const age = document.createElement("span")
    const elapsedMs = duration(job.startedAt, job.finishedAt)
    age.textContent = job.expectedMs
      ? `${formatDuration(elapsedMs)} / ~${formatDuration(job.expectedMs)}`
      : formatDuration(elapsedMs)
    details.append(stateLabel, age)
    card.append(details)

    if (job.state === "running" && job.expectedMs) {
      const budget = document.createElement("div")
      const ratio = elapsedMs / job.expectedMs
      budget.className = `budget${ratio > 1 ? " overrun" : ""}`
      const fill = document.createElement("span")
      fill.style.width = `${Math.min(100, ratio * 100)}%`
      if (ratio < 1) {
        fill.className = "advancing"
        fill.style.animationDuration = `${job.expectedMs - elapsedMs}ms`
      }
      budget.append(fill)
      card.append(budget)
    }

    const outputSection = document.createElement("section")
    outputSection.className = "live-output"
    const outputHeader = document.createElement("div")
    outputHeader.className = "output-header"
    outputHeader.append(textElement("span", "", "Live output"))
    const tabs = document.createElement("div")
    tabs.className = "stream-tabs"
    const activeStream = selectedOutput.get(job.id) ?? "stdout"
    selectedOutput.set(job.id, activeStream)
    for (const stream of ["stdout", "stderr", "progress"] as const) {
      const button = document.createElement("button")
      button.textContent = stream
      button.className = stream === activeStream ? "active" : ""
      button.addEventListener("click", () => {
        selectedOutput.set(job.id, stream)
        render()
        void refreshOutput(job.id, stream)
      })
      tabs.append(button)
    }
    outputHeader.append(tabs)
    const output = document.createElement("pre")
    output.className = "output-view"
    const activeState = streamState(job.id, activeStream)
    activeState.element = output
    output.addEventListener("scroll", () => {
      activeState.scrollTop = output.scrollTop
      activeState.followTail =
        output.scrollHeight - output.clientHeight - output.scrollTop < 16
    })
    outputSection.append(outputHeader, output)
    if (job.state === "running") {
      outputSection.append(textElement("div", "output-note", "Following live sidecar bytes"))
    }
    card.append(outputSection)
    paintOutput(activeState)

    const technical = document.createElement("details")
    technical.open = expanded.has(job.id)
    technical.addEventListener("toggle", () => {
      if (technical.open) expanded.add(job.id)
      else expanded.delete(job.id)
    })
    const summaryElement = document.createElement("summary")
    summaryElement.textContent = "Details"
    const list = document.createElement("dl")
    detailRow(list, "Start", job.startedAt)
    if (job.finishedAt) detailRow(list, "Finish", job.finishedAt)
    detailRow(list, "PGID", String(job.pgid))
    detailRow(list, "Directory", job.jobDir)
    technical.append(summaryElement, list)
    card.append(technical)

    if (job.state === "completed") {
      const dismiss = document.createElement("button")
      dismiss.className = "dismiss"
      dismiss.textContent = "\u00d7"
      dismiss.title = "Dismiss completed job"
      dismiss.setAttribute("aria-label", "Dismiss completed job")
      dismiss.addEventListener("click", () => {
        dismissed.add(job.id)
        render()
        void saveDismissed().catch((error) =>
          showNotice(
            `Could not save dismissal: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      })
      card.append(dismiss)
    }

    const actions = document.createElement("div")
    actions.className = "actions"
    if (job.state === "running") {
      const stop = document.createElement("button")
      stop.className = "danger"
      const confirming = confirmStop?.id === job.id && confirmStop.until > Date.now()
      stop.textContent = job.cancellationRequested
        ? "Cancellation requested"
        : confirming
          ? "Confirm stop"
          : "Stop"
      stop.disabled = job.cancellationRequested
      stop.addEventListener("click", () => {
        if (!sessionId || job.cancellationRequested) return
        if (!confirming) {
          confirmStop = { id: job.id, until: Date.now() + 5000 }
          render()
          return
        }
        confirmStop = null
        stop.disabled = true
        void host
          .serviceRequest({
            method: "POST",
            path: `/jobs/${job.id}/cancel`,
            query: { session: sessionId },
          })
          .then(() => refresh())
          .catch((error) => {
            showNotice(
              `Could not request cancellation: ${error instanceof Error ? error.message : String(error)}`,
            )
            render()
          })
      })
      actions.append(stop)
    }
    if (actions.childElementCount > 0) card.append(actions)
    jobsRoot.append(card)
  }
}

async function refresh() {
  const currentSession = sessionId
  const generation = ++requestGeneration
  if (!currentSession) {
    jobsRoot.replaceChildren()
    message.hidden = false
    message.textContent = "Open a conversation to see its jobs."
    return
  }
  if (!dismissalsReady) return

  try {
    const result = await host.serviceRequest({
      method: "GET",
      path: "/jobs",
      query: { session: currentSession },
    })
    if (generation !== requestGeneration || currentSession !== sessionId) return
    if (result.status !== 200) throw new Error(`Service answered ${result.status}`)
    const payload = JSON.parse(result.body) as { jobs?: VisibleJob[] }
    jobs = Array.isArray(payload.jobs) ? payload.jobs : []
    const retained = new Set(jobs.map((job) => job.id))
    const pruned = new Set([...dismissed].filter((id) => retained.has(id)))
    if (pruned.size !== dismissed.size) {
      dismissed = pruned
      void saveDismissed()
    }
    showNotice("")
    render()
  } catch (error) {
    if (generation !== requestGeneration || currentSession !== sessionId) return
    jobsRoot.replaceChildren()
    message.hidden = false
    message.textContent = `Could not read perk jobs: ${error instanceof Error ? error.message : String(error)}`
  }
}

host.onReady((context) => applyHostReady(context, document.documentElement))
host.onSession((session) => {
  sessionId = session?.id ?? null
  jobs = []
  dismissed = new Set()
  expanded = new Set()
  selectedOutput = new Map()
  streamStates = new Map()
  programScroll = new Map()
  dismissalsReady = false
  confirmStop = null
  requestGeneration += 1
  render()
  if (!sessionId) {
    void refresh()
    return
  }
  const loadingSession = sessionId
  void host.storage
    .get(storageKey(loadingSession))
    .then((value) => {
      if (sessionId !== loadingSession) return
      dismissed = new Set(
        Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
      )
      dismissalsReady = true
      return refresh()
    })
    .catch((error) => {
      if (sessionId !== loadingSession) return
      dismissalsReady = true
      showNotice(
        `Could not load dismissals: ${error instanceof Error ? error.message : String(error)}`,
      )
      return refresh()
    })
})
window.setInterval(() => void refresh(), 1000)
window.setInterval(() => {
  for (const job of jobs) {
    if (dismissed.has(job.id)) continue
    const stream = selectedOutput.get(job.id) ?? "stdout"
    const state = streamState(job.id, stream)
    if (job.state === "running" || !state.complete) {
      void refreshOutput(job.id, stream)
    }
  }
}, 500)

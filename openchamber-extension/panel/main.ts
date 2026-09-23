import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { describeOutcome, type VisibleJob } from "../../src/protocol.js"
import { createMockHost, type PanelHost } from "./mock-host.js"

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
  scrollLeft: number
  restoring: boolean
  element: HTMLPreElement | null
  error: string | null
}

const host: PanelHost = new URLSearchParams(location.search).has("mock")
  ? createMockHost()
  : connectHost()
const previewStyle = new URLSearchParams(location.search).get("style")
if (new URLSearchParams(location.search).has("mock") && ["quiet", "rail", "console"].includes(previewStyle ?? "")) {
  document.documentElement.dataset.previewStyle = previewStyle!
  if (new URLSearchParams(location.search).get("theme") === "light") {
    document.documentElement.dataset.previewTheme = "light"
  }
  const stylesheet = document.createElement("link")
  stylesheet.rel = "stylesheet"
  stylesheet.href = "preview-styles.css"
  document.head.append(stylesheet)
}
const jobsRoot = document.querySelector<HTMLDivElement>("#jobs")!
const toolbar = document.querySelector<HTMLDivElement>("#toolbar")!
const message = document.querySelector<HTMLDivElement>("#message")!
const notice = document.querySelector<HTMLDivElement>("#notice")!
let sessionId: string | null = null
let requestGeneration = 0
let jobs: VisibleJob[] = []
let collapseStateReady = false
let collapsed = new Set<string>()
let autoCollapse = false
let selectedOutput = new Map<string, OutputStream>()
let streamStates = new Map<string, StreamState>()
let programScroll = new Map<string, { top: number; left: number }>()
let titleScroll = new Map<string, number>()
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
  if (minutes < 60) {
    const remainingSeconds = seconds % 60
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
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
  return `collapsed:${id}`
}

function legacyStorageKey(id: string): string {
  return `dismissed:${id}`
}

async function saveCollapsed() {
  if (!sessionId) return
  await host.storage.set(storageKey(sessionId), [...collapsed])
}

function renderToolbar() {
  toolbar.hidden = jobs.length === 0
  toolbar.replaceChildren()
  if (!jobs.length) return

  const title = textElement("span", "toolbar-title", "Background jobs")
  const controls = document.createElement("div")
  controls.className = "toolbar-controls"
  const expand = document.createElement("button")
  expand.textContent = "Expand all"
  expand.disabled = jobs.every((job) => !collapsed.has(job.id))
  expand.addEventListener("click", () => {
    collapsed.clear()
    render()
    void saveCollapsed().catch((error) => showNotice(`Could not save collapsed cards: ${String(error)}`))
  })
  const collapse = document.createElement("button")
  collapse.textContent = "Collapse all"
  collapse.disabled = jobs.every((job) => collapsed.has(job.id))
  collapse.addEventListener("click", () => {
    collapsed = new Set(jobs.map((job) => job.id))
    render()
    void saveCollapsed().catch((error) => showNotice(`Could not save collapsed cards: ${String(error)}`))
  })
  const automatic = document.createElement("button")
  automatic.className = "auto-collapse"
  automatic.textContent = "Auto-collapse"
  automatic.title = "Collapse running jobs when they finish"
  automatic.setAttribute("aria-pressed", String(autoCollapse))
  automatic.addEventListener("click", () => {
    autoCollapse = !autoCollapse
    renderToolbar()
    void host.storage.set("auto-collapse-completed", autoCollapse).catch((error) =>
      showNotice(`Could not save auto-collapse preference: ${String(error)}`),
    )
  })
  controls.append(expand, collapse, automatic)
  toolbar.append(title, controls)
}

function showNotice(text: string) {
  notice.textContent = text
  notice.style.display = text ? "block" : "none"
}

function detailRow(list: HTMLDListElement, term: string, value: string) {
  list.append(textElement("dt", "", term), textElement("dd", "", value))
}

function updateTitleFade(title: HTMLElement) {
  const remaining = title.scrollWidth - title.clientWidth - title.scrollLeft
  title.style.setProperty("--title-fade-left", title.scrollLeft > 1 ? "16px" : "0px")
  title.style.setProperty("--title-fade-right", remaining > 1 ? "16px" : "0px")
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
      scrollLeft: 0,
      restoring: false,
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
  if (element.isConnected && element.dataset.painted && !state.restoring) {
    state.scrollLeft = element.scrollLeft
    if (!state.followTail) state.scrollTop = element.scrollTop
  }
  state.restoring = true
  element.textContent = state.error
    ? `Could not read output: ${state.error}`
    : state.text || (state.complete ? "(no output)" : "Waiting for output...")
  element.dataset.painted = "true"
  requestAnimationFrame(() => {
    if (state.element !== element) return
    if (state.followTail) element.scrollTop = element.scrollHeight
    else element.scrollTop = state.scrollTop
    element.scrollLeft = state.scrollLeft
    state.restoring = false
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
  const focusedJobId = document.activeElement instanceof HTMLElement &&
    document.activeElement.classList.contains("card-header")
    ? document.activeElement.dataset.jobId
    : null
  jobsRoot.querySelectorAll<HTMLElement>(".job").forEach((card) => {
    const id = card.dataset.jobId
    if (!id || card.dataset.sessionId !== sessionId) return
    if (card.classList.contains("collapsed")) {
      const title = card.querySelector<HTMLElement>(".task-summary")
      if (title) titleScroll.set(id, title.scrollLeft)
      return
    }
    const program = card.querySelector<HTMLElement>(".program")
    if (program) programScroll.set(id, { top: program.scrollTop, left: program.scrollLeft })
    const output = card.querySelector<HTMLPreElement>(".output-view")
    const stream = output?.dataset.stream as OutputStream | undefined
    if (output && stream) {
      const state = streamState(id, stream)
      if (!state.restoring) {
        state.scrollTop = output.scrollTop
        state.scrollLeft = output.scrollLeft
      }
    }
  })
  jobsRoot.replaceChildren()
  renderToolbar()
  message.hidden = jobs.length > 0
  message.textContent = "No background jobs in this conversation."

  for (const job of jobs) {
    const state = status(job)
    const elapsedMs = duration(job.startedAt, job.finishedAt)
    const card = document.createElement("article")
    card.dataset.jobId = job.id
    card.dataset.sessionId = sessionId ?? ""
    const isCollapsed = collapsed.has(job.id)
    card.className = `job ${state.tone}${isCollapsed ? " collapsed" : ""}`
    const header = document.createElement("header")
    header.className = "card-header"
    header.dataset.jobId = job.id
    header.tabIndex = 0
    header.setAttribute("role", "button")
    header.setAttribute("aria-expanded", String(!isCollapsed))
    const statusLine = document.createElement("div")
    statusLine.className = "status-line"
    const stateLabel = textElement("span", "state", state.label)
    const age = textElement(
      "span",
      "elapsed",
      job.expectedMs
        ? `${formatDuration(elapsedMs)} / ~${formatDuration(job.expectedMs)}`
        : formatDuration(elapsedMs),
    )
    statusLine.append(stateLabel, age)
    if (job.state === "running") {
      const stop = document.createElement("button")
      stop.className = "stop-control danger"
      const confirming = confirmStop?.id === job.id && confirmStop.until > Date.now()
      stop.textContent = job.cancellationRequested
        ? "Stopping"
        : confirming
          ? "Confirm stop"
          : "Stop"
      stop.disabled = job.cancellationRequested
      stop.addEventListener("click", (event) => {
        event.stopPropagation()
        if (!sessionId || job.cancellationRequested) return
        if (!confirming) {
          confirmStop = { id: job.id, until: Date.now() + 10_000 }
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
      statusLine.append(stop)
    }
    const taskSummary = document.createElement("div")
    taskSummary.className = "task-summary"
    taskSummary.textContent =
      job.label?.trim() || job.command.split("\n").find((line) => line.trim())?.trim() || "Unnamed job"
    taskSummary.addEventListener("scroll", () => {
      if (!taskSummary.isConnected || !isCollapsed) return
      titleScroll.set(job.id, taskSummary.scrollLeft)
      updateTitleFade(taskSummary)
    })
    header.setAttribute("aria-label", `${isCollapsed ? "Expand" : "Collapse"} ${taskSummary.textContent}`)
    const toggle = () => {
      if (isCollapsed) collapsed.delete(job.id)
      else collapsed.add(job.id)
      render()
      void saveCollapsed().catch((error) =>
        showNotice(
          `Could not save collapsed cards: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
    header.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) return
      toggle()
    })
    header.addEventListener("keydown", (event) => {
      if (event.target !== header) return
      if (isCollapsed && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        if (taskSummary.scrollWidth <= taskSummary.clientWidth) return
        event.preventDefault()
        taskSummary.scrollLeft += event.key === "ArrowRight" ? 80 : -80
        return
      }
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      toggle()
    })
    header.append(taskSummary, statusLine)
    card.append(header)
    requestAnimationFrame(() => {
      if (!taskSummary.isConnected) return
      if (isCollapsed) {
        taskSummary.scrollLeft = titleScroll.get(job.id) ?? 0
        updateTitleFade(taskSummary)
      }
    })
    const program = document.createElement("pre")
    program.className = "program"
    program.textContent = job.command
    const savedProgramScroll = programScroll.get(job.id) ?? { top: 0, left: 0 }
    program.addEventListener("scroll", () => {
      if (!program.isConnected) return
      programScroll.set(job.id, {
        top: program.scrollTop,
        left: program.scrollLeft,
      })
    })
    card.append(program)
    requestAnimationFrame(() => {
      if (!program.isConnected) return
      program.scrollTop = savedProgramScroll.top
      program.scrollLeft = savedProgramScroll.left
    })
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
    output.dataset.stream = activeStream
    const activeState = streamState(job.id, activeStream)
    activeState.element = output
    output.addEventListener("scroll", () => {
      if (!output.isConnected || activeState.restoring) return
      activeState.scrollTop = output.scrollTop
      activeState.scrollLeft = output.scrollLeft
      activeState.followTail =
        output.scrollHeight - output.clientHeight - output.scrollTop < 16
    })
    outputSection.append(outputHeader, output)
    if (job.state === "running") {
      outputSection.append(textElement("div", "output-note", "Following live sidecar bytes"))
    }
    card.append(outputSection)
    paintOutput(activeState)

    const technical = document.createElement("section")
    technical.className = "technical"
    const list = document.createElement("dl")
    detailRow(list, "Job ID", job.id)
    detailRow(list, "Start", job.startedAt)
    if (job.finishedAt) detailRow(list, "Finish", job.finishedAt)
    detailRow(list, "PGID", String(job.pgid))
    detailRow(list, "Directory", job.jobDir)
    technical.append(list)
    card.append(technical)
    if (job.state === "running" && job.expectedMs) {
      const budget = document.createElement("div")
      const ratio = elapsedMs / job.expectedMs
      budget.className = `budget${ratio > 1 ? " overrun" : ""}`
      budget.setAttribute("role", "progressbar")
      budget.setAttribute("aria-label", "Estimated duration elapsed")
      budget.setAttribute("aria-valuemin", "0")
      budget.setAttribute("aria-valuemax", "100")
      budget.setAttribute("aria-valuenow", String(Math.min(100, Math.floor(ratio * 100))))
      const fill = document.createElement("span")
      fill.style.width = `${Math.min(100, ratio * 100)}%`
      if (ratio < 1) {
        fill.className = "advancing"
        fill.style.animationDuration = `${job.expectedMs - elapsedMs}ms`
      }
      budget.append(fill)
      card.append(budget)
    }

    jobsRoot.append(card)
  }
  if (focusedJobId) jobsRoot.querySelector<HTMLElement>(`[data-job-id="${focusedJobId}"]`)?.focus()
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
  if (!collapseStateReady) return

  try {
    const result = await host.serviceRequest({
      method: "GET",
      path: "/jobs",
      query: { session: currentSession },
    })
    if (generation !== requestGeneration || currentSession !== sessionId) return
    if (result.status !== 200) throw new Error(`Service answered ${result.status}`)
    const payload = JSON.parse(result.body) as { jobs?: VisibleJob[] }
    const nextJobs = Array.isArray(payload.jobs) ? payload.jobs : []
    if (autoCollapse) {
      const previous = new Map(jobs.map((job) => [job.id, job.state]))
      let changed = false
      for (const job of nextJobs) {
        if (previous.get(job.id) === "running" && job.state === "completed") {
          collapsed.add(job.id)
          changed = true
        }
      }
      if (changed) void saveCollapsed().catch((error) => showNotice(`Could not save collapsed cards: ${String(error)}`))
    }
    jobs = nextJobs
    const retained = new Set(jobs.map((job) => job.id))
    const pruned = new Set([...collapsed].filter((id) => retained.has(id)))
    if (pruned.size !== collapsed.size) {
      collapsed = pruned
      void saveCollapsed()
    }
    showNotice("")
    render()
  } catch (error) {
    if (generation !== requestGeneration || currentSession !== sessionId) return
    jobsRoot.replaceChildren()
    toolbar.hidden = true
    message.hidden = false
    message.textContent = `Could not read perk jobs: ${error instanceof Error ? error.message : String(error)}`
  }
}

host.onReady((context) => applyHostReady(context, document.documentElement))
host.onSession((session) => {
  sessionId = session?.id ?? null
  jobs = []
  collapsed = new Set()
  selectedOutput = new Map()
  streamStates = new Map()
  programScroll = new Map()
  titleScroll = new Map()
  collapseStateReady = false
  confirmStop = null
  requestGeneration += 1
  render()
  if (!sessionId) {
    void refresh()
    return
  }
  const loadingSession = sessionId
  void Promise.all([
    host.storage.get(storageKey(loadingSession)),
    host.storage.get(legacyStorageKey(loadingSession)),
    host.storage.get("auto-collapse-completed"),
  ])
    .then(([value, legacyValue, preference]) => {
      if (sessionId !== loadingSession) return
      autoCollapse = preference === true
      const stored = Array.isArray(value) ? value : legacyValue
      collapsed = new Set(
        Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [],
      )
      collapseStateReady = true
      if (!Array.isArray(value) && Array.isArray(legacyValue)) void saveCollapsed()
      return refresh()
    })
    .catch((error) => {
      if (sessionId !== loadingSession) return
      collapseStateReady = true
      showNotice(
        `Could not load collapsed cards: ${error instanceof Error ? error.message : String(error)}`,
      )
      return refresh()
    })
})
window.setInterval(() => void refresh(), 1000)
window.setInterval(() => {
  for (const job of jobs) {
    if (collapsed.has(job.id)) continue
    const stream = selectedOutput.get(job.id) ?? "stdout"
    const state = streamState(job.id, stream)
    if (job.state === "running" || !state.complete) {
      void refreshOutput(job.id, stream)
    }
  }
}, 500)

import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listJobs,
  readJobOutput,
  requestCancellation,
  type OutputStream,
} from "./jobs.js"

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT)
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ""
const spoolDir = join(tmpdir(), "opencode", "perk")

if (!port || !token) {
  console.error(
    "OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required",
  )
  process.exit(1)
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(body))
}

const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: "unauthorized" })
    return
  }

  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true })
    return
  }
  if (request.method === "GET" && url.pathname === "/jobs") {
    const sessionId = url.searchParams.get("session")?.trim() ?? ""
    if (!sessionId || sessionId.length > 512) {
      json(response, 400, { error: "a valid session is required" })
      return
    }
    json(response, 200, { jobs: listJobs(spoolDir, sessionId) })
    return
  }
  const outputMatch = url.pathname.match(
    /^\/jobs\/([0-9a-f]{8})\/output\/(stdout|stderr|progress)$/,
  )
  if (request.method === "GET" && outputMatch) {
    const sessionId = url.searchParams.get("session")?.trim() ?? ""
    const offset = Number(url.searchParams.get("offset") ?? "0")
    if (
      !sessionId ||
      sessionId.length > 512 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      json(response, 400, { error: "a valid session and offset are required" })
      return
    }
    const chunk = readJobOutput(
      spoolDir,
      outputMatch[1],
      sessionId,
      outputMatch[2] as OutputStream,
      offset,
    )
    if (!chunk) {
      json(response, 404, { error: "not-found" })
      return
    }
    json(response, 200, chunk)
    return
  }
  const cancelMatch = url.pathname.match(/^\/jobs\/([0-9a-f]{8})\/cancel$/)
  if (request.method === "POST" && cancelMatch) {
    const sessionId = url.searchParams.get("session")?.trim() ?? ""
    if (!sessionId || sessionId.length > 512) {
      json(response, 400, { error: "a valid session is required" })
      return
    }
    const result = requestCancellation(spoolDir, cancelMatch[1], sessionId)
    const status =
      result.state === "requested" ? 202 : result.state === "completed" ? 409 : 404
    json(response, status, result)
    return
  }
  json(response, 404, { error: "not-found" })
})

server.listen(port, "127.0.0.1")

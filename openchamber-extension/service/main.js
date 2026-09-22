// openchamber-extension/service/main.ts
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// openchamber-extension/service/jobs.ts
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { join } from "node:path";

// src/protocol.ts
function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function parseLaunch(value, expectedId) {
  if (!value || typeof value !== "object") return null;
  const v = value;
  if (v.schema !== 1 && v.schema !== 2 || v.id !== expectedId || typeof v.sessionId !== "string" || v.label !== void 0 && typeof v.label !== "string" || typeof v.command !== "string" || typeof v.cwd !== "string" || !positiveInteger(v.pgid) || typeof v.startedAt !== "string" || !Number.isFinite(Date.parse(v.startedAt)) || v.schema === 2 && !positiveInteger(v.timeoutMs) || v.timeoutMs !== void 0 && !positiveInteger(v.timeoutMs) || v.expectedMs !== void 0 && !positiveInteger(v.expectedMs)) return null;
  let expectedMs = v.expectedMs;
  if (v.schema === 1 && expectedMs === void 0 && v.expectedSeconds !== void 0) {
    if (typeof v.expectedSeconds !== "number" || !Number.isFinite(v.expectedSeconds) || v.expectedSeconds <= 0) return null;
    expectedMs = Math.max(1, Math.round(v.expectedSeconds * 1e3));
    if (!positiveInteger(expectedMs)) return null;
  }
  return {
    id: expectedId,
    sessionId: v.sessionId,
    ...v.label === void 0 ? {} : { label: v.label },
    command: v.command,
    cwd: v.cwd,
    pgid: v.pgid,
    startedAt: v.startedAt,
    ...v.timeoutMs === void 0 ? {} : { timeoutMs: v.timeoutMs },
    ...expectedMs === void 0 ? {} : { expectedMs }
  };
}

// openchamber-extension/service/jobs.ts
var JOB_ID = /^[0-9a-f]{8}$/;
var MAX_METADATA_BYTES = 64 * 1024;
function readLaunch(path, expectedId) {
  try {
    if (statSync(path).size > MAX_METADATA_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8"));
    return parseLaunch(value, expectedId);
  } catch {
    return null;
  }
}
function readOutcome(path) {
  try {
    const stat = statSync(path);
    const outcome = stat.size > 128 ? "?" : readFileSync(path, "utf8").trim() || "?";
    return { outcome, finishedAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}
function validJobDirectory(spoolDir2, id) {
  if (!JOB_ID.test(id)) return null;
  const dir = join(spoolDir2, id);
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null;
  } catch {
    return null;
  }
}
function listJobs(spoolDir2, sessionId) {
  let entries;
  try {
    entries = readdirSync(spoolDir2, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    const dir = join(spoolDir2, entry.name);
    const launch = readLaunch(join(dir, "launch.json"), entry.name);
    if (!launch || launch.sessionId !== sessionId) continue;
    const result = readOutcome(join(dir, "exit"));
    jobs.push({
      ...launch,
      jobDir: dir,
      cancellationRequested: existsSync(join(dir, "cancel")),
      state: result === null ? "running" : "completed",
      ...result === null ? {} : result
    });
  }
  return jobs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
function requestCancellation(spoolDir2, id, sessionId) {
  const dir = validJobDirectory(spoolDir2, id);
  if (!dir) return { state: "not-found" };
  const launch = readLaunch(join(dir, "launch.json"), id);
  if (!launch || launch.sessionId !== sessionId) return { state: "not-found" };
  if (readOutcome(join(dir, "exit"))) return { state: "completed" };
  const path = join(dir, "cancel");
  try {
    closeSync(openSync(path, "wx", 384));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return { state: "requested" };
}
var STREAM_FILE = {
  stdout: "out",
  stderr: "err",
  progress: "drip"
};
function readJobOutput(spoolDir2, id, sessionId, stream, requestedOffset, maxBytes = 64 * 1024) {
  const dir = validJobDirectory(spoolDir2, id);
  if (!dir) return null;
  const launch = readLaunch(join(dir, "launch.json"), id);
  if (!launch || launch.sessionId !== sessionId) return null;
  const path = join(dir, STREAM_FILE[stream]);
  let size = 0;
  let identity = null;
  try {
    const stat = statSync(path);
    size = stat.size;
    identity = `${stat.dev}:${stat.ino}`;
  } catch {
  }
  const reset = requestedOffset > size;
  const offset = reset ? 0 : requestedOffset;
  const length = Math.min(Math.max(0, maxBytes), size - offset);
  const buffer = Buffer.alloc(length);
  let read = 0;
  let fd;
  try {
    if (length > 0) {
      fd = openSync(path, "r");
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, offset + read);
        if (count === 0) break;
        read += count;
      }
    }
  } catch {
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
  const nextOffset = offset + read;
  return {
    identity,
    offset,
    nextOffset,
    size,
    data: buffer.subarray(0, read).toString("base64"),
    complete: readOutcome(join(dir, "exit")) !== null && nextOffset >= size,
    reset
  };
}

// openchamber-extension/service/main.ts
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
var spoolDir = join2(tmpdir(), "opencode", "perk");
if (!port || !token) {
  console.error(
    "OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required"
  );
  process.exit(1);
}
function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
var server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/jobs") {
    const sessionId = url.searchParams.get("session")?.trim() ?? "";
    if (!sessionId || sessionId.length > 512) {
      json(response, 400, { error: "a valid session is required" });
      return;
    }
    json(response, 200, { jobs: listJobs(spoolDir, sessionId) });
    return;
  }
  const outputMatch = url.pathname.match(
    /^\/jobs\/([0-9a-f]{8})\/output\/(stdout|stderr|progress)$/
  );
  if (request.method === "GET" && outputMatch) {
    const sessionId = url.searchParams.get("session")?.trim() ?? "";
    const offset = Number(url.searchParams.get("offset") ?? "0");
    if (!sessionId || sessionId.length > 512 || !Number.isSafeInteger(offset) || offset < 0) {
      json(response, 400, { error: "a valid session and offset are required" });
      return;
    }
    const chunk = readJobOutput(
      spoolDir,
      outputMatch[1],
      sessionId,
      outputMatch[2],
      offset
    );
    if (!chunk) {
      json(response, 404, { error: "not-found" });
      return;
    }
    json(response, 200, chunk);
    return;
  }
  const cancelMatch = url.pathname.match(/^\/jobs\/([0-9a-f]{8})\/cancel$/);
  if (request.method === "POST" && cancelMatch) {
    const sessionId = url.searchParams.get("session")?.trim() ?? "";
    if (!sessionId || sessionId.length > 512) {
      json(response, 400, { error: "a valid session is required" });
      return;
    }
    const result = requestCancellation(spoolDir, cancelMatch[1], sessionId);
    const status = result.state === "requested" ? 202 : result.state === "completed" ? 409 : 404;
    json(response, status, result);
    return;
  }
  json(response, 404, { error: "not-found" });
});
server.listen(port, "127.0.0.1");

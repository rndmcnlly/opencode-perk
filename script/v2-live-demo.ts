import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = process.argv[2]
const modelID = process.argv[3] ?? "Qwen3.8-27B-oQ6"
if (!binary) throw new Error("usage: tsx script/v2-live-demo.ts /path/to/opencode [model]")
if (!process.env.OMLX_API_KEY) throw new Error("OMLX_API_KEY is not set")

const root = await mkdtemp(join(tmpdir(), "perk-v2-live-"))
await mkdir(join(root, ".opencode", "plugins"), { recursive: true })
await symlink(resolve("src-v2"), join(root, ".opencode", "plugins", "perk-v2"), "dir")
const config = {
  share: "disabled",
  provider: {
    omlx: {
      npm: "@ai-sdk/openai-compatible",
      name: "omlx",
      options: { baseURL: "http://localhost:12348/v1", apiKey: "{env:OMLX_API_KEY}" },
      models: { [modelID]: {} },
    },
  },
}
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
}
const service = spawn(resolve(binary), ["serve", "--service"], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] })
let stderr = ""
service.stderr.setEncoding("utf8")
service.stderr.on("data", (chunk) => (stderr += chunk))

try {
  const registration = await waitForRegistration(join(root, "state", "opencode"))
  const info = JSON.parse(await readFile(registration, "utf8")) as { url: string; password: string }
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
    "content-type": "application/json",
  }
  const created = await request(info.url, headers, "POST", "/api/session", {
    title: "perk V2 live demonstration",
    model: { providerID: "omlx", id: modelID },
    location: { directory: root },
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  }) as { data: { id: string } }
  const sessionID = created.data.id
  await request(info.url, headers, "POST", `/api/session/${sessionID}/prompt`, {
    text: [
      "This is a live test of the perk V2 progress relay.",
      "Use the shell tool exactly once with background:true and run this exact command:",
      "printf 'phase 1: preparing\\n'; sleep 8; printf 'phase 2: compiling\\n'; sleep 8; printf 'phase 3: complete\\n'",
      "After launching it, do not poll or run another tool. Briefly acknowledge each progress or completion message you receive.",
    ].join("\n"),
  })

  let messages: unknown[] = []
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const response = await request(info.url, headers, "GET", `/api/session/${sessionID}/message?order=asc&limit=200`) as { data: unknown[] }
    messages = response.data
    const text = JSON.stringify(messages)
    if (text.includes("phase 3: complete") && text.includes("source\\\":\\\"shell") && text.includes("opencode-perk-v2-spike")) {
      await new Promise((done) => setTimeout(done, 3_000))
      const final = await request(info.url, headers, "GET", `/api/session/${sessionID}/message?order=asc&limit=200`) as { data: unknown[] }
      messages = final.data
      break
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  const output = join(process.cwd(), "V2-LIVE-TRANSCRIPT.json")
  await writeFile(output, JSON.stringify({ opencode: await version(binary, env), model: `omlx/${modelID}`, sessionID, messages }, null, 2))
  console.log(output)
} finally {
  service.kill("SIGTERM")
  await new Promise((done) => setTimeout(done, 1_000))
  if (service.exitCode === null) service.kill("SIGKILL")
  if (stderr) await writeFile(join(process.cwd(), "V2-LIVE-SERVICE.log"), stderr)
  await rm(root, { recursive: true, force: true })
}

async function request(url: string, headers: Record<string, string>, method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}\n${stderr}`)
  return text ? JSON.parse(text) : undefined
}

async function waitForRegistration(directory: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = await readdir(directory).catch(() => [])
    const file = entries.find((entry) => entry === "service.json" || /^service-.*\.json$/.test(entry))
    if (file) return join(directory, file)
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error(`V2 service did not register\n${stderr}`)
}

async function version(path: string, childEnv: NodeJS.ProcessEnv) {
  return new Promise<string>((done, fail) => {
    const child = spawn(resolve(path), ["--version"], { env: childEnv })
    let output = ""
    child.stdout.on("data", (chunk) => (output += chunk))
    child.once("error", fail)
    child.once("exit", (code) => (code === 0 ? done(output.trim()) : fail(new Error(`version exited ${code}`))))
  })
}

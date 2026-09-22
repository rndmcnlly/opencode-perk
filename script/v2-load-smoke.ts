import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const binary = process.argv[2]
if (!binary) throw new Error("usage: npm run smoke:v2 -- /path/to/source-built/opencode")

const root = await mkdtemp(join(tmpdir(), "perk-v2-smoke-"))
const pluginDirectory = join(root, ".opencode", "plugins")
await mkdir(pluginDirectory, { recursive: true })
await symlink(resolve("src-v2"), join(pluginDirectory, "perk-v2"), "dir")

const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_TEST_HOME: root,
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
}
const service = spawn(resolve(binary), ["serve", "--service"], {
  cwd: root,
  env,
  stdio: ["ignore", "ignore", "pipe"],
})
let stderr = ""
service.stderr.setEncoding("utf8")
service.stderr.on("data", (chunk) => {
  stderr += chunk
})

try {
  const registration = await waitForRegistration(join(root, "state", "opencode"))
  const info = JSON.parse(await readFile(registration, "utf8")) as {
    url: string
    password: string
  }
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`,
  }
  const endpoint = new URL("/api/plugin", info.url)
  endpoint.searchParams.set("location[directory]", root)
  const ids = await waitForPlugins(endpoint, headers)
  if (!ids.includes("opencode-perk-v2-spike")) {
    throw new Error(`V2 loaded plugins ${JSON.stringify(ids)}, but not the perk spike`)
  }
  console.log(`loaded opencode-perk-v2-spike with ${await version(binary)}`)
} finally {
  service.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolveExit) => service.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ])
  if (service.exitCode === null) service.kill("SIGKILL")
  await rm(root, { recursive: true, force: true })
}

async function waitForRegistration(directory: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const entries = await readdir(directory).catch(() => [])
    const file = entries.find((entry) => entry === "service.json" || /^service-.*\.json$/.test(entry))
    if (file) return join(directory, file)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error(`V2 service did not register\n${stderr}`)
}

async function waitForPlugins(endpoint: URL, headers: Record<string, string>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(endpoint, { headers }).catch(() => undefined)
    if (response?.ok) {
      const body = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = body.data?.flatMap((plugin) => (typeof plugin.id === "string" ? [plugin.id] : [])) ?? []
      if (ids.includes("opencode-perk-v2-spike")) return ids
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(`V2 did not load the perk spike\n${stderr}`)
}

async function version(path: string) {
  return new Promise<string>((resolveVersion, rejectVersion) => {
    const child = spawn(resolve(path), ["--version"], { env })
    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.once("error", rejectVersion)
    child.once("exit", (code) =>
      code === 0 ? resolveVersion(output.trim()) : rejectVersion(new Error(`opencode --version exited ${code}`)),
    )
  })
}

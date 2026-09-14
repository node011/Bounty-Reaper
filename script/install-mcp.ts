#!/usr/bin/env bun
/**
 * Register the bundled MCP servers with BountyReaper globally.
 *
 * Why this exists: `.bountyreaper/bountyreaper.jsonc` in this repo is a *project*
 * config — BountyReaper only reads it when the working directory is inside the
 * repo. Open BountyReaper anywhere else and the bundled servers are simply not
 * configured. Global config lives at `~/.config/bountyreaper/bountyreaper.json`
 * and applies everywhere.
 *
 * Global config needs absolute paths (MCP servers inherit the app's cwd, and
 * McpLocal has no `cwd` option), and absolute paths differ per machine — so they
 * cannot be committed. This script writes them at install time from wherever the
 * repo actually sits.
 *
 *   bun run script/install-mcp.ts            # add/update the bundled servers
 *   bun run script/install-mcp.ts --dry-run  # print the merged config, write nothing
 *   bun run script/install-mcp.ts --remove   # drop them again
 */

import path from "path"
import os from "os"

const root = path.resolve(import.meta.dir, "..")
const dry = process.argv.includes("--dry-run")
const remove = process.argv.includes("--remove")

const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "bountyreaper")

// jsonc wins over json in BountyReaper's load order, so an existing .jsonc would
// silently shadow anything written to .json. Extend whichever one is there.
const existing = ["bountyreaper.jsonc", "bountyreaper.json"]
  .map((f) => path.join(configDir, f))
  .find((p) => Bun.file(p).size > 0)

const target = existing ?? path.join(configDir, "bountyreaper.json")

const uv = Bun.which("uv")
if (!uv && !remove) {
  console.error("uv not found on PATH. Install it first: https://docs.astral.sh/uv/")
  console.error("The bundled MCP servers all run through `uv run`.")
  process.exit(1)
}

/** A bundled server: uv runs it from its own directory, so its venv is used. */
function server(dir: string, ...args: string[]) {
  return {
    type: "local" as const,
    command: ["uv", "run", "--directory", path.join(root, "mcp", dir), "python", ...args],
    enabled: true,
  }
}

const SERVERS: Record<string, ReturnType<typeof server>> = {
  bb_recon: server("bb-recon", "-m", "bb_recon.server"),
  burp: server("burp", "burp_mcp_server.py"),
}

const names = Object.keys(SERVERS)

let config: Record<string, any> = {}
if (existing) {
  const text = await Bun.file(existing).text()
  try {
    // Strip // and /* */ so a .jsonc file parses. Good enough for config files;
    // it does not try to be a full JSONC parser.
    config = JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1"))
  } catch {
    console.error(`Could not parse ${existing}.`)
    console.error("Fix or move it, then re-run — refusing to overwrite a config I can't read.")
    process.exit(1)
  }
}

config.$schema ??= "https://bountyreper.io/config.json"
config.mcp ??= {}

if (remove) {
  for (const name of names) delete config.mcp[name]
} else {
  // Merge, never replace: anything else the user configured stays untouched,
  // and a server they deliberately disabled stays disabled.
  for (const [name, spec] of Object.entries(SERVERS)) {
    config.mcp[name] = { ...spec, ...(config.mcp[name]?.enabled === false ? { enabled: false } : {}) }
  }
}

const out = JSON.stringify(config, null, 2) + "\n"

if (dry) {
  console.log(`# would write ${target}\n`)
  console.log(out)
  process.exit(0)
}

await Bun.write(target, out)

console.log(`${remove ? "Removed" : "Registered"} ${names.length} MCP servers in ${target}`)
if (!remove) {
  console.log(`  repo: ${root}`)
  for (const name of names) {
    const enabled = config.mcp[name].enabled !== false
    console.log(`  ${enabled ? "✓" : "·"} ${name}${enabled ? "" : "  (disabled — needs API keys, see .env.example)"}`)
  }
  console.log("\nThese now load in every folder, not just this repo.")
  console.log("Moving the repo invalidates the paths — re-run this script after a move.")
}

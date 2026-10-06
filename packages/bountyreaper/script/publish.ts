#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@bountyreaper-io/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

// mythos-reaper MCP launcher — shipped as a npm bin ("mythos-reaper-mcp") and
// installed to ~/.bountyreaper/bin by postinstall so the built-in config entry
// (config.ts: command ["mythos-reaper-mcp"]) resolves on any machine.
const LAUNCHER_SH = `#!/bin/sh
# mythos-reaper MCP launcher — installed by bountyreaper.
# Bootstraps a venv on first run, then serves the MCP over stdio.
set -e
PKG_DIR="$HOME/.local/share/bountyreaper/mythos-reaper"
VENV="$PKG_DIR/.venv"
RUNS_DIR="\${MYTHOS_REAPER_RUNS:-$PKG_DIR/runs}"

if [ ! -x "$VENV/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    (cd "$PKG_DIR" && uv venv "$VENV" >/dev/null 2>&1)
    "$VENV/bin/python" -m ensurepip >/dev/null 2>&1 || true
  else
    python3 -m venv "$VENV"
  fi
fi
if ! "$VENV/bin/python" -c "import mcp" >/dev/null 2>&1; then
  "$VENV/bin/python" -m pip install --quiet "mcp>=1.2.0,<2" 2>/dev/null \\
    || "$VENV/bin/python" -m ensurepip >/dev/null 2>&1 && "$VENV/bin/python" -m pip install --quiet "mcp>=1.2.0,<2"
fi
export MYTHOS_REAPER_RUNS="$RUNS_DIR"
cd "$PKG_DIR"
exec "$VENV/bin/python" -m mythos_reaper.mcp_server "$@"
`

const SCOPE = "@bountyreaper-io"
const scopedName = `${SCOPE}/${pkg.name}`
const distDir = `dist/${pkg.name}`

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const binPkg = await Bun.file(`./dist/${filepath}`).json()
  // Prefix binary package names with scope
  const scopedBinName = binPkg.name.startsWith(SCOPE) ? binPkg.name : `${SCOPE}/${binPkg.name}`
  binaries[scopedBinName] = binPkg.version
}
console.log("binaries", binaries)
if (Object.keys(binaries).length === 0) {
  console.error("No binary packages found in dist/. Run build.ts first.")
  process.exit(1)
}
const version = Object.values(binaries)[0]

await $`mkdir -p ./${distDir}`
await $`cp -r ./bin ./${distDir}/bin`
await $`cp ./script/postinstall.mjs ./${distDir}/postinstall.mjs`
await $`cp ./script/preuninstall.mjs ./${distDir}/preuninstall.mjs`
await Bun.file(`./${distDir}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./${distDir}/README.md`).write(await Bun.file("./README.md").text())

// Bundle web UI if available (built by publish workflow build-app job)
const webDistPath = "../../packages/app/dist"
const webDestPath = `./${distDir}/web`
if (await Bun.file(`${webDistPath}/index.html`).exists()) {
  await $`cp -r ${webDistPath} ${webDestPath}`
  console.log("Bundled web UI into npm package")
} else {
  console.warn("Warning: Web UI dist not found — npm package will not include web UI")
}

// Bundle built-in skills
const skillSrcPath = "../../.bountyreaper/skill"
const skillDestPath = `./${distDir}/skill`
const { existsSync } = await import("fs")
if (existsSync(skillSrcPath)) {
  await $`cp -r ${skillSrcPath} ${skillDestPath}`
  console.log("Bundled skills into npm package")
} else {
  console.warn("Warning: Skills not found — npm package will not include built-in skills")
}

// Bundle the mythos-reaper audit-harness MCP engine (installed to
// Global.Path.data by postinstall.mjs; launched via the generic
// mythos-reaper-mcp launcher registered as a npm bin below).
const mythosSrcPath = "../../mcp/mythos-reaper"
if (existsSync(mythosSrcPath)) {
  await $`rm -rf ./${distDir}/mythos-reaper/.venv ./${distDir}/mythos-reaper/runs`
  await $`cp -r ${mythosSrcPath} ./${distDir}/mythos-reaper`
  // Write the PATH-resolvable launcher that the built-in config entry
  // (config.ts: command ["mythos-reaper-mcp"]) spawns.
  await Bun.file(`./${distDir}/bin/mythos-reaper-mcp`).write(LAUNCHER_SH)
  await $`chmod +x ./${distDir}/bin/mythos-reaper-mcp`
  console.log("Bundled mythos-reaper engine + launcher into npm package")
} else {
  console.warn("Warning: mythos-reaper not found — npm package will not include the mythos harness")
}

// Bundle hackbrowser worker JS (subprocess.md). Placed by postinstall into
// Global.Path.bin (~/.local/share/bountyreaper/bin/) so the main binary can
// spawn it at runtime without playwright in the main binary's module graph.
const workerSrcPath = "./dist/hackbrowser-worker/hackbrowser-worker.js"
const workerDestPath = `./${distDir}/hackbrowser-worker.js`
if (await Bun.file(workerSrcPath).exists()) {
  await $`cp ${workerSrcPath} ${workerDestPath}`
  console.log("Bundled hackbrowser-worker.js into npm package")
} else {
  console.warn("Warning: hackbrowser-worker.js not found — run build.ts first")
}

await Bun.file(`./${distDir}/package.json`).write(
  JSON.stringify(
    {
      name: scopedName,
      description: pkg.description,
      bin: {
        [pkg.name]: `./bin/${pkg.name}`,
        "mythos-reaper-mcp": "./bin/mythos-reaper-mcp",
      },
      scripts: {
        postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
        preuninstall: "bun ./preuninstall.mjs || node ./preuninstall.mjs || true",
      },
      version: version,
      license: pkg.license,
      keywords: pkg.keywords,
      homepage: "https://bountyreper.io",
      repository: {
        type: "git",
        url: "https://github.com/node011/Bounty-Reaper.git",
      },
      dependencies: {
        // playwright is an npm dependency so it is installed next to the
        // worker JS and can be resolved at runtime. It is NOT bundled into
        // the main binary (subprocess.md — zero playwright in main binary).
        playwright: "1.58.2",
      },
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  // name is scoped like "@bountyreaper-io/bountyreaper-darwin-arm64"
  // directory on disk is just "bountyreaper-darwin-arm64"
  const dirName = name.replace(`${SCOPE}/`, "")
  if (process.platform !== "win32") {
    await $`chmod -R 755 .`.cwd(`./dist/${dirName}`)
  }
  await $`bun pm pack`.cwd(`./dist/${dirName}`)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(`./dist/${dirName}`)
})
await Promise.all(tasks)
await $`cd ./${distDir} && bun pm pack && npm publish *.tgz --access public --tag ${Script.channel}`

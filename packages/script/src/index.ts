import { $, semver } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  BOUNTYREAPER_CHANNEL: process.env["BOUNTYREAPER_CHANNEL"],
  BOUNTYREAPER_BUMP: process.env["BOUNTYREAPER_BUMP"],
  BOUNTYREAPER_VERSION: process.env["BOUNTYREAPER_VERSION"],
  BOUNTYREAPER_RELEASE: process.env["BOUNTYREAPER_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.BOUNTYREAPER_CHANNEL) return env.BOUNTYREAPER_CHANNEL
  if (env.BOUNTYREAPER_BUMP === "beta") return "beta"
  if (env.BOUNTYREAPER_BUMP === "canary") return "canary"
  if (env.BOUNTYREAPER_BUMP) return "latest"
  if (env.BOUNTYREAPER_VERSION && !env.BOUNTYREAPER_VERSION.startsWith("0.0.0-")) {
    // Extract prerelease tag from semver (e.g. "1.1.6-beta.1" → "beta")
    const pre = env.BOUNTYREAPER_VERSION.match(/-([a-z]+)/i)?.[1]
    return pre ?? "latest"
  }
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.BOUNTYREAPER_VERSION) return env.BOUNTYREAPER_VERSION
  if (IS_PREVIEW && env.BOUNTYREAPER_BUMP !== "beta" && env.BOUNTYREAPER_BUMP !== "canary")
    return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`

  const registry = (await fetch("https://registry.npmjs.org/@bountyreaper-io%2Fbountyreaper").then((res) => {
    if (!res.ok) throw new Error(res.statusText)
    return res.json()
  })) as { "dist-tags": Record<string, string>; versions: Record<string, unknown> }

  if (env.BOUNTYREAPER_BUMP === "beta" || env.BOUNTYREAPER_BUMP === "canary") {
    const pre = env.BOUNTYREAPER_BUMP // "beta" | "canary" — separate dist-tags, separate counters
    const latest = registry["dist-tags"]?.latest
    if (!latest) throw new Error("No published latest version found on npm")
    const [major, minor, patch] = latest.split(".").map((x: string) => Number(x) || 0)

    const current = registry["dist-tags"]?.[pre]
    if (current) {
      const m = current.match(new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)-${pre}\\.(\\d+)$`))
      if (m) {
        const [, bMaj, bMin, bPatch, bNum] = m
        const sameMajor = Number(bMaj) === major
        const sameMinor = Number(bMin) === minor
        const samePatch = Number(bPatch) === patch + 1
        if (sameMajor && sameMinor && samePatch) {
          return `${bMaj}.${bMin}.${bPatch}-${pre}.${Number(bNum) + 1}`
        }
      }
    }
    return `${major}.${minor}.${patch + 1}-${pre}.0`
  }

  const version = registry["dist-tags"]?.latest
  if (!version) throw new Error("No published latest version found on npm")
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.BOUNTYREAPER_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const team = [
  "actions-user",
  "bountyreaper",
  "rekram1-node",
  "thdxr",
  "kommander",
  "jayair",
  "fwang",
  "adamdotdevin",
  "iamdavidhill",
  "bountyreaper-agent[bot]",
  "R44VC0RP",
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.BOUNTYREAPER_RELEASE
  },
  get team() {
    return team
  },
}
console.log(`bountyreaper script`, JSON.stringify(Script, null, 2))

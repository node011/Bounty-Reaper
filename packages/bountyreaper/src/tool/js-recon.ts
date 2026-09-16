import z from "zod"
import { Tool } from "./tool"
import { Intel } from "../methodology/intel"
import { Session } from "../session"
import { Vulnerability } from "../session/vulnerability"
import { Log } from "@/util/log"

const log = Log.create({ service: "js-recon" })

const description = `Static JavaScript reconnaissance for a target domain (powered by BundleBleed, passive-only).

Collects client-side JS + server-rendered pages, then extracts:
- candidate API endpoints (fetch/axios/XHR/SendBeacon/GraphQL patterns)
- secrets (redacted at ingest: type + preview + partial hash, never plaintext)
- in-domain subdomains and security-interesting parameters
- DOM-XSS sink/source co-occurrence and higher-severity shapes (SSRF-shaped params,
  prototype-pollution deep-merge, JWT alg:none, CORS * + credentials, Firebase exposure)

Every endpoint/parameter/secret lands as intel; vulnerability-shaped hypotheses are
recorded as CANDIDATE findings (proof-gated lifecycle — a human/tester must verify).

PASSIVE BY DEFAULT: archive (gau/waybackurls) + JS download GETs only. No crawling,
no fuzzing, no writes. Runtime capture is NOT exposed here.

Requires the BundleBleed CLI on PATH (or BUNDLEBLEED_BIN): https://github.com/shaikarifali/bundlebleed
Install: git clone the repo && uv sync (Python 3.12+).`

type BundleHypothesis = {
  id?: string
  title?: string
  summary?: string
  risk_tier?: string
  confidence?: number
  shape?: string
  evidence_ids?: string[]
}

type BundleSecret = {
  type?: string
  preview?: string
  hash?: string
  source?: string
}

type BundleScanResult = {
  hypotheses?: BundleHypothesis[]
  secrets?: BundleSecret[]
  subdomains?: string[]
  parameters?: string[]
  endpoints?: Array<string | { url?: string; path?: string; runtime_confirmed?: boolean }>
}

type ScanCounts = {
  endpoints: number
  parameters: number
  subdomains: number
  secrets: number
  hypotheses: number
}

type ReconMeta = {
  available?: boolean
  exitCode?: number
  added?: ScanCounts
  outputDir?: string
}

const zeroCounts = (): ScanCounts => ({ endpoints: 0, parameters: 0, subdomains: 0, secrets: 0, hypotheses: 0 })

export const JsReconTool = Tool.define("js_recon", {
  description,
  parameters: z.object({
    target: z.string().describe("Target domain to scan (e.g. example.com)"),
    scope_extra: z
      .array(z.string())
      .optional()
      .describe("Extra in-scope domains (comma-separated list as array)"),
    download: z
      .boolean()
      .optional()
      .default(true)
      .describe("Fetch JS/page bodies for deep extraction (passive GETs only). Default true."),
    concurrency: z.number().int().min(1).max(20).optional().describe("Max concurrent JS downloads (default 5)"),
  }),
  async execute(params, ctx) {
    const bin = process.env.BUNDLEBLEED_BIN ?? "bundlebleed"
    const sessionID = Session.root(ctx.sessionID)
    const meta: ReconMeta = {}

    const which = Bun.which(bin)
    if (!which) {
      meta.available = false
      return {
        title: "BundleBleed not installed",
        output: [
          "The BundleBleed CLI is not on PATH (checked BUNDLEBLEED_BIN then `bundlebleed`).",
          "",
          "Install (Python 3.12+ and uv required):",
          "  git clone https://github.com/shaikarifali/bundlebleed.git",
          "  cd bundlebleed && uv sync",
          "  # then either: uv run bundlebleed --help   (from that directory)",
          "  # or add the venv binary to PATH / set BUNDLEBLEED_BIN to it",
          "",
          "Alternatively run the scan yourself and hand me the results/ dir:",
          "  uv run bundlebleed scan -t <target> -o results/",
        ].join("\n"),
        metadata: meta,
      }
    }

    const outDir = `/tmp/js-recon-${sessionID.slice(-8)}-${Date.now()}`
    // scope_extra is documented as domains but lands on the BundleBleed argv —
    // validate so a flag-looking value (--output, --exec, ...) can't smuggle
    // BundleBleed options (argument injection via LLM-supplied params).
    const extra: string[] = []
    for (const domain of params.scope_extra ?? []) {
      const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]
      if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(clean))
        return { title: "js_recon rejected", output: `Invalid scope_extra domain: ${domain}`, metadata: meta }
      extra.push(clean)
    }
    const args = ["scan", "-t", params.target, "-o", outDir, "--no-active", ...extra]
    if (params.download === false) args.push("--no-download")
    if (params.concurrency) args.push("--concurrency", String(params.concurrency))

    log.info("running bundlebleed", { target: params.target, outDir })
    const proc = Bun.spawn([bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUNDLEBLEED_NO_INTERACTIVE: "1" },
    })
    const timer = setTimeout(() => proc.kill(), 15 * 60 * 1000)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)

    const scanFile = `${outDir}/scan-result.json`
    if (code !== 0 || !(await Bun.file(scanFile).exists())) {
      meta.exitCode = code
      return {
        title: "js_recon failed",
        output: [
          `BundleBleed exited ${code} — no scan-result.json produced.`,
          stderr.split("\n").slice(-10).join("\n"),
          stdout.split("\n").slice(-10).join("\n"),
        ].filter(Boolean).join("\n"),
        metadata: meta,
      }
    }

    const scan = (await Bun.file(scanFile).json()) as BundleScanResult
    const intel = Intel.get(sessionID)
    const seen = new Set(intel.map((e) => e.title))

    const added = zeroCounts()

    for (const item of scan.endpoints ?? []) {
      const url = typeof item === "string" ? item : item.url ?? item.path
      if (!url || seen.has(`endpoint:${url}`)) continue
      seen.add(`endpoint:${url}`)
      Intel.add({
        sessionID,
        data: {
          type: "endpoint",
          title: `endpoint:${url}`,
          source: "bundlebleed",
          asset: params.target,
          detail: typeof item === "object" && item.runtime_confirmed ? "runtime-confirmed request" : undefined,
          tags: ["js-recon", "static-analysis"],
        },
      })
      added.endpoints++
    }

    for (const p of scan.parameters ?? []) {
      if (seen.has(`param:${p}`)) continue
      seen.add(`param:${p}`)
      Intel.add({
        sessionID,
        data: {
          type: "parameter",
          title: `parameter:${p}`,
          source: "bundlebleed",
          asset: params.target,
          tags: ["js-recon"],
        },
      })
      added.parameters++
    }

    for (const s of scan.subdomains ?? []) {
      if (seen.has(`subdomain:${s}`)) continue
      seen.add(`subdomain:${s}`)
      Intel.add({
        sessionID,
        data: {
          type: "subdomain",
          title: s,
          source: "bundlebleed",
          asset: params.target,
          tags: ["js-recon"],
        },
      })
      added.subdomains++
    }

    for (const sec of scan.secrets ?? []) {
      if (!sec.type) continue
      // BundleBleed redacts at ingest (type + preview + partial hash) — never plaintext.
      const title = `secret:${sec.type}${sec.hash ? ` (${sec.hash.slice(0, 8)})` : ""}`
      if (seen.has(title)) continue
      seen.add(title)
      Intel.add({
        sessionID,
        data: {
          type: "sensitive_data",
          severity: "high",
          title,
          detail: `redacted finding — preview: ${sec.preview ?? "n/a"}, verify before reporting`,
          source: "bundlebleed",
          asset: params.target,
          tags: ["js-recon", "secrets"],
        },
      })
      added.secrets++
    }

    for (const h of scan.hypotheses ?? []) {
      const shape = h.shape ?? h.title ?? "unknown"
      const title = `[JS-RECON HYPOTHESIS] ${shape}${h.title && h.title !== shape ? `: ${h.title}` : ""}`
      if (seen.has(title)) continue
      seen.add(title)
      // Hypotheses are proof-gated candidates, not findings — medium/info tier.
      Vulnerability.add({
        sessionID,
        data: {
          severity: "low",
          title,
          description:
            [
              h.summary,
              h.confidence != null ? `BundleBleed confidence: ${h.confidence}${h.risk_tier ? ` (${h.risk_tier} tier)` : ""}` : "",
              "",
              "[Static-analysis hypothesis — NO verification performed. Test before reporting:",
              "draft a targeted probe via http_replay, then re-report with execution evidence to promote.",
            ].filter(Boolean).join("\n"),
        },
      })
      added.hypotheses++
    }

    const summary = [
      `js_recon complete for ${params.target} (passive-only).`,
      `intel added: ${added.endpoints} endpoints, ${added.parameters} parameters, ${added.subdomains} subdomains, ${added.secrets} secrets (redacted).`,
      `hypotheses recorded as candidates: ${added.hypotheses} — verify before promoting.`,
      `artifacts: ${outDir}/ (scan-result.json/md/html, wordlists/, audit_log.jsonl)`,
    ].join("\n")

    meta.added = added
    meta.outputDir = outDir

    return {
      title: `js_recon: ${params.target}`,
      output: summary,
      metadata: { added: meta.added, outputDir: meta.outputDir, available: meta.available, exitCode: meta.exitCode },
    }
  },
})

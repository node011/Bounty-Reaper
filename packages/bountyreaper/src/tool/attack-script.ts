import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { Network } from "../network/network"
import { Gate } from "./gate"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Engagement } from "../methodology/engagement"
import { Session } from "../session"

/**
 * Script directory resolution. The compiled single binary broke the naive
 * `import.meta.dir` path (a hunt hit "script resolution failed twice" and the agent
 * fell back to locating oob_interactsh.py by hand — the correct python path was
 * discovered only after all XXE/SSRF lanes had been shelved). Resolution order:
 *   1. BOUNTYREAPER_SCRIPTS_DIR env override (operators/CI)
 *   2. source layout (dev): src/tool -> ../../data/scripts
 *   3. packaged layout: binary at <pkg>/bin -> <pkg>/data/scripts (build copies it)
 *   4. user install layout: ~/.bountyreaper/data/scripts
 *   5. walk up from the session-worktree cwd (repo checkouts, any depth)
 * The first candidate containing oob_interactsh.py wins.
 */
function resolveScriptsDir(): string {
  const probe = (dir: string | undefined) => dir && Bun.file(path.join(dir, "oob_interactsh.py")).exists()
  const candidates = [
    process.env.BOUNTYREAPER_SCRIPTS_DIR,
    path.resolve(import.meta.dir, "../../data/scripts"),
    path.resolve(import.meta.dir, "../data/scripts"),
    path.resolve(import.meta.dir, "data/scripts"),
  ]
  try {
    candidates.push(path.resolve(Global.Path.bin, "../data/scripts"))
  } catch {}
  // cwd walk-up (repo checkouts and arbitrary project roots)
  let base: string | undefined
  try {
    base = Instance.directory
  } catch {}
  if (!base) {
    try {
      base = Instance.worktree
    } catch {}
  }
  if (base) {
    let cur: string | undefined = base
    for (let i = 0; i < 5 && cur; i++) {
      candidates.push(path.join(cur, "data", "scripts"))
      const parent = path.dirname(cur)
      // Stop at filesystem root instead of looping forever on "/".
      cur = parent === cur ? undefined : cur
    }
  }
  for (const dir of candidates) if (dir && probe(dir)) return dir
  const listed = candidates.filter(Boolean).join(",")
  throw new Error(
    "attack_script resources not found. Tried: " +
      listed +
      ". Set BOUNTYREAPER_SCRIPTS_DIR to the directory containing oob_interactsh.py.",
  )
}

const SCRIPTS_DIR = resolveScriptsDir()

const AVAILABLE_SCRIPTS: Record<string, { description: string; args: string }> = {
  jwt_tamper: {
    description: "JWT token decode/modify/re-encode for auth bypass testing (alg=none, role escalation, user ID swap)",
    args: "TOKEN [--decode-only] [--set key=value] [--set-header key=value] [--key SECRET] [--json-output]",
  },
  race_tester: {
    description: "Race condition tester — concurrent requests to detect TOCTOU vulnerabilities",
    args: "URL [-m METHOD] [-H key:value] [-d JSON_BODY] [-c COUNT] [--delay MS] [--json-output]",
  },
  ssrf_listener: {
    description: "SSRF callback listener — lightweight HTTP server that logs all incoming requests as evidence",
    args: "[-p PORT] [-o OUTPUT_FILE] [--timeout SECONDS]",
  },
  oob_interactsh: {
    description:
      "DEFAULT OOB channel — Interactsh blind-callback collector (DNS/HTTP/SMTP/LDAP). `new` starts a session and prints the payload domain; `poll --state DIR` prints decoded interactions; `stop` kills it. Use for ALL blind OOB (SSRF callbacks, blind OSCI/DNS exfil, Log4Shell-style). Burp Collaborator ONLY when the operator explicitly names it.",
    args: "new [--server URL] [--state DIR] | poll --state DIR [--timeout SECONDS] | stop --state DIR",
  },
  file_upload_tester: {
    description: "File upload vulnerability tester — extension bypass, MIME bypass, polyglot files, SVG XSS/SSRF",
    args: "URL [--field NAME] [-H key:value] [--data JSON] [--json-output]",
  },
  cloud_storage_enum: {
    description: "Cloud storage enumeration — S3/Azure/GCP bucket discovery with permission checks",
    args: "TARGET [--names BUCKET_NAME...] [--json-output]",
  },
  subdomain_takeover: {
    description: "Subdomain takeover checker — CNAME detection + cloud service fingerprint matching (20 services)",
    args: "FILE_OR_DOMAIN [--json-output]",
  },
  github_dorker: {
    description: "GitHub intelligence dorker — search for leaked secrets using gh CLI (30+ patterns)",
    args: "ORG [--repo ORG/REPO] [--patterns PATTERN...] [--commits] [--json-output]",
  },
  wayback_endpoints: {
    description: "Wayback Machine endpoint discovery — find historical/hidden endpoints via CDX API",
    args: "DOMAIN [--probe] [--limit N] [--json-output]",
  },
  js_recon: {
    description:
      "JS bundle recon — extract API endpoints, route literals, GraphQL ops, absolute/WS URLs, config keys, blob URLs, JWT-like strings and secret-candidate URLs from live bundle URLs or local files. HIGHEST-ROI recon in live hunts: the full client-side API map comes from bundles, not endpoint guessing. PREFER this over blind unauth path probes (bundle-first rule).",
    args: "URL_OR_LOCAL_FILE... [--limit N] [--json-output]",
  },
}

export const AttackScriptTool = Tool.define("attack_script", {
  description: `Execute a bundled attack script for specialized capabilities beyond http_replay (crypto ops, async concurrency, binary file generation, recon). Available scripts: ${Object.keys(AVAILABLE_SCRIPTS).join(", ")}. Each script outputs structured results. Use --json-output for machine-readable output.`,
  parameters: z.object({
    script: z.enum(Object.keys(AVAILABLE_SCRIPTS) as [string, ...string[]]).describe(
      "Script to execute. Options: " +
        Object.entries(AVAILABLE_SCRIPTS)
          .map(([k, v]) => `${k} — ${v.description}`)
          .join("; "),
    ),
    args: z.array(z.string()).describe("Arguments to pass to the script"),
    timeout_seconds: z.number().optional().default(120).describe("Maximum execution time in seconds (default: 120)"),
  }),
  async execute(params, ctx) {
    // OOB-callback engagement gate: when an ROE record exists, callbacks must
    // be explicitly approved on it (audit: engagement-level OOB approval flag).
    if (params.script === "oob_interactsh") {
      const eng = Engagement.get(Session.root(ctx.sessionID))
      if (eng && !eng.oobApproved) {
        return {
          title: "attack_script: oob_interactsh",
          output:
            "OOB callbacks are NOT approved for this engagement. If the operator has approved out-of-band " +
            "callbacks, update the engagement first: engagement_setup with oob_approved=true.",
          metadata: { script: params.script, exitCode: -1, hasStderr: false },
        }
      }
    }
    await Gate.execute(ctx, { tool: "attack_script", what: params.script, detail: { args: params.args } })
    const scriptPath = path.join(SCRIPTS_DIR, `${params.script}.py`)
    const file = Bun.file(scriptPath)
    if (!(await file.exists())) {
      return {
        title: `attack_script: ${params.script}`,
        output: `Script not found: ${params.script}.py\n\nAvailable scripts:\n${Object.entries(AVAILABLE_SCRIPTS)
          .map(([k, v]) => `  ${k}: ${v.description}\n    Usage: ${v.args}`)
          .join("\n")}`,
        metadata: { script: params.script, exitCode: -1, hasStderr: false },
      }
    }

    // These scripts send real traffic at the target, so they follow the same
    // outbound policy as everything else. We do not own their code, so the
    // proxy is handed over as environment variables — the one interface every
    // HTTP library in them honours. Empty when no proxy is configured.
    let netEnv: Record<string, string>
    try {
      netEnv = await Network.childEnv()
    } catch (err) {
      // A configuration the scripts genuinely cannot honour (SOCKS). Refusing is
      // deliberate: running anyway would either leak past the proxy or fail with
      // an error that names the target instead of the setting.
      return {
        title: `attack_script: ${params.script}`,
        output: err instanceof Error ? err.message : String(err),
        metadata: { script: params.script, exitCode: -1, hasStderr: false },
      }
    }

    const proc = Bun.spawn(["python3", scriptPath, ...params.args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...netEnv, PYTHONDONTWRITEBYTECODE: "1" },
    })

    const timeout = setTimeout(() => {
      proc.kill()
    }, params.timeout_seconds * 1000)

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])

    clearTimeout(timeout)
    const exitCode = await proc.exited

    const output = [stdout]
    if (stderr.trim()) output.push(`\n--- stderr ---\n${stderr}`)
    if (exitCode !== 0) output.push(`\nExit code: ${exitCode}`)

    return {
      title: `attack_script: ${params.script}`,
      output: output.join(""),
      metadata: {
        script: params.script,
        exitCode,
        hasStderr: stderr.trim().length > 0,
      },
    }
  },
})

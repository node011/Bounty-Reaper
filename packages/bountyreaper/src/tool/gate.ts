import type { Tool } from "./tool"

/**
 * Permission gate for the post-exploitation and audit tools.
 *
 * These tools spawn processes, harvest credentials, install persistence and move
 * laterally, yet historically none of them asked for anything — while `ls` and
 * `grep` did. That inversion meant the safe tools were gated and the dangerous
 * ones were not, and a prompt-injected agent could dump `/etc/shadow` without
 * the operator seeing a prompt.
 *
 * Risk comes from what an operation *does*, not which OS it runs on, so the
 * categories below are shared across linuxhook, winhook, machook and the cloud
 * hooks. Recon is auto-approved because enumeration is the whole point of the
 * tool and prompting on every `system_info` trains people to click through;
 * everything that takes credentials, changes the target, or moves off it asks.
 */
export namespace Gate {
  export type Category =
    | "recon"
    | "credential"
    | "privesc"
    | "persistence"
    | "lateral"
    | "evasion"
    | "exfil"
    | "network"
    | "exec"
    | "audit"
    | "unknown"

  /** Categories that never prompt: read-only enumeration of the current host. */
  const SILENT: ReadonlySet<Category> = new Set<Category>(["recon", "audit"])

  const RISK: Record<Category, string> = {
    recon: "read-only enumeration",
    audit: "read-only configuration audit",
    credential: "harvests credentials from the target",
    privesc: "attempts privilege escalation",
    persistence: "installs persistence on the target",
    lateral: "moves to another host",
    evasion: "tampers with logs or security controls",
    exfil: "moves data off the target",
    network: "active network manipulation (spoofing, MITM, capture)",
    exec: "executes arbitrary code",
    unknown: "unclassified post-exploitation action",
  }

  /**
   * Map a category module's filename to a Category. Hook packages all use the
   * same layout (recon.ts, credential.ts, privesc.ts, ...), so classification is
   * derived from where a handler actually lives rather than a hand-maintained
   * list that drifts as programs are added.
   */
  export function fromModule(name: string): Category {
    const n = name.toLowerCase()
    if (n.includes("recon") || n.includes("enum") || n.includes("monitor") || n.includes("compliance")) return "recon"
    if (n.includes("credential") || n.includes("kerberos") || n.includes("identity")) return "credential"
    if (n.includes("privesc") || n.includes("exploit") || n.includes("injection")) return "privesc"
    if (n.includes("persistence")) return "persistence"
    if (n.includes("lateral") || n.includes("hybrid")) return "lateral"
    if (n.includes("evasion") || n.includes("cleanup")) return "evasion"
    if (n.includes("exfil") || n.includes("impact")) return "exfil"
    if (n.includes("network")) return "network"
    return "unknown"
  }

  /**
   * Classify by program name. Used for single-file hooks, and as the fallback
   * for handlers defined inline in a dispatch map rather than imported from a
   * category module.
   *
   * Order matters: the dangerous prefixes are tested before the read-only ones,
   * so `dump_creds` classifies as credential rather than being caught by a
   * generic "list/show" rule and silently auto-approved.
   */
  export function fromName(program: string): Category {
    const n = program.toLowerCase()
    const has = (...xs: string[]) => xs.some((x) => n.includes(x))

    if (has("cred", "secret", "password", "passwd", "shadow", "hash", "token", "keychain", "keyring", "ticket"))
      return "credential"
    if (has("persist", "backdoor", "implant", "autorun", "startup")) return "persistence"
    if (has("exfil", "stage", "tunnel", "upload", "steal")) return "exfil"
    if (has("lateral", "pivot", "psexec", "wmiexec", "ssh_", "movement")) return "lateral"
    if (has("evasion", "evade", "clear", "tamper", "timestomp", "hide", "bypass", "cleanup", "wipe")) return "evasion"
    if (has("privesc", "escalate", "suid", "sudo", "exploit", "inject", "hijack", "preload")) return "privesc"
    if (has("spoof", "mitm", "poison", "arp", "capture", "sniff")) return "network"
    if (has("detect", "enum", "info", "list", "show", "scan", "audit", "check", "discover", "recon", "harvest_env"))
      return "recon"
    return "unknown"
  }

  /** Module membership first (accurate), program name second (fallback). */
  export function classify(program: string, moduleName?: string): Category {
    if (moduleName) {
      const fromMod = fromModule(moduleName)
      if (fromMod !== "unknown") return fromMod
    }
    return fromName(program)
  }

  /**
   * Ask before running a post-exploitation program.
   *
   * Patterns are `<tool>:<category>:<program>` so an operator can approve one
   * program, and `always` is `<tool>:<category>:*` so they can approve a whole
   * category for the engagement without opening up the rest of the tool.
   */
  export async function ask(
    ctx: Tool.Context,
    input: { tool: string; program: string; category: Category; detail?: Record<string, unknown> },
  ) {
    if (SILENT.has(input.category)) return

    const pattern = `${input.tool}:${input.category}:${input.program}`
    await ctx.ask({
      permission: "postexploit",
      patterns: [pattern],
      always: [`${input.tool}:${input.category}:*`],
      metadata: {
        tool: input.tool,
        program: input.program,
        category: input.category,
        risk: RISK[input.category],
        ...input.detail,
      },
    })
  }

  /** Gate for tools that run code directly rather than a named program. */
  export async function execute(
    ctx: Tool.Context,
    input: { tool: string; what: string; detail?: Record<string, unknown> },
  ) {
    await ctx.ask({
      permission: "postexploit",
      patterns: [`${input.tool}:exec:${input.what}`],
      always: [`${input.tool}:exec:*`],
      metadata: { tool: input.tool, risk: RISK.exec, ...input.detail },
    })
  }
}

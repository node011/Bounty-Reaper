import z from "zod"
import { Tool } from "./tool"

/**
 * Installing software is a privileged, hard-to-reverse act, so two rules apply
 * to every entry here:
 *
 * 1. Pin the version. `@latest` means two operators on the same engagement run
 *    different scanners and cannot reproduce each other's findings, and it means
 *    a compromised upstream lands on the box the moment it is published.
 *
 * 2. Name the real upstream. Several of these tools have PyPI names that are
 *    placeholders or third-party uploads rather than the project itself:
 *    `paramspider` and `nosqlmap` on PyPI are literally "Reserved name
 *    placeholder. No functionality.", and `commix` on PyPI is published by
 *    someone other than commixproject. Those install from git at a pinned ref.
 *
 * Bump a pin by editing VERSIONS; nothing else needs to change.
 */
const VERSIONS = {
  nuclei: "v3.11.1",
  ffuf: "v2.2.1",
  httpx: "v1.11.0",
  subfinder: "v2.16.0",
  amass: "v4.2.0",
  waybackurls: "v0.1.0",
  gau: "v2.2.4",
  hakrawler: "v0.0.0-20260805040537-52a16fe61bd1",
  katana: "v1.7.0",
  dalfox: "v2.13.0",
  "interactsh-client": "v1.3.1",
  gospider: "v1.1.6",
  crlfuzz: "v1.4.1",
  sqlmap: "1.10.9",
  arjun: "2.2.7",
  gitdumper: "1.0.9",
  commix: "v4.1",
  paramspider: "v1.0.1",
  nosqlmap: "0.5",
  ssrfmap: "290e07d75c52",
} as const

type Spec = {
  check: string
  install: string
  description: string
  /** Printed after a successful install so the run records what landed. */
  version?: string
  /** Managed by the OS package manager — no pin available, and that is fine. */
  unpinned?: true
}

const go = (mod: string, version: string) => `go install -v ${mod}@${version}`
const pip = (pkg: string, version: string) => `pip3 install '${pkg}==${version}'`
const git = (repo: string, ref: string) => `pip3 install 'git+https://github.com/${repo}@${ref}'`

const TOOL_INSTALL_MAP: Record<string, Spec> = {
  nmap: {
    check: "nmap",
    install: "brew install nmap || sudo apt-get install -y nmap",
    description: "Network scanner",
    unpinned: true,
  },
  nuclei: {
    check: "nuclei",
    install: go("github.com/projectdiscovery/nuclei/v3/cmd/nuclei", VERSIONS.nuclei),
    description: "Vulnerability scanner",
    version: VERSIONS.nuclei,
  },
  ffuf: {
    check: "ffuf",
    install: go("github.com/ffuf/ffuf/v2", VERSIONS.ffuf),
    description: "Web fuzzer",
    version: VERSIONS.ffuf,
  },
  httpx: {
    check: "httpx",
    install: go("github.com/projectdiscovery/httpx/cmd/httpx", VERSIONS.httpx),
    description: "HTTP toolkit",
    version: VERSIONS.httpx,
  },
  subfinder: {
    check: "subfinder",
    install: go("github.com/projectdiscovery/subfinder/v2/cmd/subfinder", VERSIONS.subfinder),
    description: "Subdomain discovery",
    version: VERSIONS.subfinder,
  },
  amass: {
    // Was `@master` — an unpinned moving branch, the worst of both worlds.
    check: "amass",
    install: go("github.com/owasp-amass/amass/v4/...", VERSIONS.amass),
    description: "Attack surface mapping",
    version: VERSIONS.amass,
  },
  waybackurls: {
    check: "waybackurls",
    install: go("github.com/tomnomnom/waybackurls", VERSIONS.waybackurls),
    description: "Wayback Machine URL fetcher",
    version: VERSIONS.waybackurls,
  },
  gau: {
    check: "gau",
    install: go("github.com/lc/gau/v2/cmd/gau", VERSIONS.gau),
    description: "URL aggregator",
    version: VERSIONS.gau,
  },
  hakrawler: {
    check: "hakrawler",
    install: go("github.com/hakluke/hakrawler", VERSIONS.hakrawler),
    description: "Web crawler",
    version: VERSIONS.hakrawler,
  },
  katana: {
    check: "katana",
    install: go("github.com/projectdiscovery/katana/cmd/katana", VERSIONS.katana),
    description: "Next-gen crawler",
    version: VERSIONS.katana,
  },
  dalfox: {
    check: "dalfox",
    install: go("github.com/hahwul/dalfox/v2", VERSIONS.dalfox),
    description: "XSS scanner",
    version: VERSIONS.dalfox,
  },
  "interactsh-client": {
    check: "interactsh-client",
    install: go("github.com/projectdiscovery/interactsh/cmd/interactsh-client", VERSIONS["interactsh-client"]),
    description: "OOB interaction collector (default blind-callback channel)",
    version: VERSIONS["interactsh-client"],
  },
  gospider: {
    check: "gospider",
    install: go("github.com/jaeles-project/gospider", VERSIONS.gospider),
    description: "Web spidering",
    version: VERSIONS.gospider,
  },
  crlfuzz: {
    check: "crlfuzz",
    install: go("github.com/dwisiswant0/crlfuzz/cmd/crlfuzz", VERSIONS.crlfuzz),
    description: "CRLF injection scanner",
    version: VERSIONS.crlfuzz,
  },
  sqlmap: {
    check: "sqlmap",
    install: pip("sqlmap", VERSIONS.sqlmap),
    description: "SQL injection tool",
    version: VERSIONS.sqlmap,
  },
  arjun: {
    check: "arjun",
    install: pip("arjun", VERSIONS.arjun),
    description: "Parameter discovery",
    version: VERSIONS.arjun,
  },
  gitdumper: {
    check: "git-dumper",
    install: pip("git-dumper", VERSIONS.gitdumper),
    description: "Git repository dumper",
    version: VERSIONS.gitdumper,
  },

  // --- Installed from git: the PyPI name is not the real project -------------
  commix: {
    // PyPI `commix` 0.1 is published by a third party, not commixproject.
    check: "commix",
    install: git("commixproject/commix", VERSIONS.commix),
    description: "Command injection",
    version: VERSIONS.commix,
  },
  paramspider: {
    // PyPI `paramspider` is "Reserved name placeholder. No functionality."
    check: "paramspider",
    install: git("devanshbatham/ParamSpider", VERSIONS.paramspider),
    description: "Parameter mining",
    version: VERSIONS.paramspider,
  },
  nosqlmap: {
    // PyPI `nosqlmap` is "Reserved name placeholder. No functionality."
    check: "nosqlmap",
    install: git("codingo/NoSQLMap", VERSIONS.nosqlmap),
    description: "NoSQL injection",
    version: VERSIONS.nosqlmap,
  },
  ssrfmap: {
    // Not on PyPI at all — the old `pip3 install ssrfmap` could never succeed.
    check: "ssrfmap",
    install: git("swisskyrepo/SSRFmap", VERSIONS.ssrfmap),
    description: "SSRF exploitation",
    version: VERSIONS.ssrfmap,
  },

  // --- OS package manager ----------------------------------------------------
  nikto: {
    check: "nikto",
    install: "brew install nikto || sudo apt-get install -y nikto",
    description: "Web server scanner",
    unpinned: true,
  },
  wpscan: {
    check: "wpscan",
    install: "gem install wpscan || brew install wpscan",
    description: "WordPress scanner",
    unpinned: true,
  },
}

export const EnsureToolsTool = Tool.define("ensure_tools", {
  description:
    "Check whether security CLIs are installed and install the missing ones at pinned versions. " +
    `Available: ${Object.keys(TOOL_INSTALL_MAP).join(", ")}. ` +
    "Installs software on the host, so it asks for permission first. Pass check_only to audit without installing.",
  parameters: z.object({
    tools: z
      .array(z.string())
      .describe(`Tools to check/install. Available: ${Object.keys(TOOL_INSTALL_MAP).join(", ")}`),
    check_only: z
      .boolean()
      .optional()
      .describe("Only report what is missing; install nothing. No permission prompt in this mode."),
  }),
  async execute(params, ctx) {
    const results: Array<{ tool: string; installed: boolean; action: string; version?: string }> = []

    const known = params.tools.filter((n) => TOOL_INSTALL_MAP[n])
    for (const name of params.tools.filter((n) => !TOOL_INSTALL_MAP[n])) {
      results.push({ tool: name, installed: false, action: `Unknown tool: ${name}` })
    }

    const missing: string[] = []
    for (const name of known) {
      const spec = TOOL_INSTALL_MAP[name]
      const check = Bun.spawnSync(["which", spec.check])
      if (check.exitCode === 0) {
        results.push({ tool: name, installed: true, action: `Already installed: ${check.stdout.toString().trim()}` })
        continue
      }
      missing.push(name)
    }

    if (params.check_only) {
      for (const name of missing) {
        results.push({ tool: name, installed: false, action: `Not installed (check_only)` })
      }
      return render(results, missing.length)
    }

    if (missing.length) {
      // Running an installer is privileged and hard to undo: it fetches remote
      // code and puts executables on PATH. Show exactly what will run.
      const commands = missing.map((n) => TOOL_INSTALL_MAP[n].install)
      await ctx.ask({
        permission: "bash",
        patterns: commands,
        always: commands,
        metadata: { tools: missing, commands },
      })
    }

    for (const name of missing) {
      const spec = TOOL_INSTALL_MAP[name]
      const install = Bun.spawnSync(["sh", "-c", spec.install], { timeout: 300_000 })
      if (install.exitCode === 0) {
        results.push({
          tool: name,
          installed: true,
          action: `Installed ${spec.version ?? "(OS package)"}`,
          version: spec.version,
        })
        continue
      }
      const stderr = install.stderr.toString().trim().slice(0, 200)
      results.push({ tool: name, installed: false, action: `Install failed: ${stderr}` })
    }

    return render(results, 0)
  },
})

function render(
  results: Array<{ tool: string; installed: boolean; action: string; version?: string }>,
  pending: number,
) {
  const installed = results.filter((r) => r.installed).length
  const failed = results.length - installed
  return {
    title: `Tools: ${installed}/${results.length} ready`,
    output: [
      `Tool check: ${installed} ready, ${failed} missing/failed`,
      ...(pending ? [`${pending} would be installed (check_only)`] : []),
      "",
      ...results.map((r) => `${r.installed ? "[OK]" : "[FAIL]"} ${r.tool}: ${r.action}`),
    ].join("\n"),
    metadata: { installed, failed, results },
  }
}

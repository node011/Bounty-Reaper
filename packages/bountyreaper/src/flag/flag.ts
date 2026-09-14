function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const BOUNTYREAPER_AUTO_SHARE = truthy("BOUNTYREAPER_AUTO_SHARE")
  export const BOUNTYREAPER_GIT_BASH_PATH = process.env["BOUNTYREAPER_GIT_BASH_PATH"]
  export const BOUNTYREAPER_CONFIG = process.env["BOUNTYREAPER_CONFIG"]
  export declare const BOUNTYREAPER_CONFIG_DIR: string | undefined
  export const BOUNTYREAPER_CONFIG_CONTENT = process.env["BOUNTYREAPER_CONFIG_CONTENT"]
  export const BOUNTYREAPER_DISABLE_AUTOUPDATE = truthy("BOUNTYREAPER_DISABLE_AUTOUPDATE")
  export const BOUNTYREAPER_DISABLE_PRUNE = truthy("BOUNTYREAPER_DISABLE_PRUNE")
  export const BOUNTYREAPER_DISABLE_TERMINAL_TITLE = truthy("BOUNTYREAPER_DISABLE_TERMINAL_TITLE")
  export const BOUNTYREAPER_PERMISSION = process.env["BOUNTYREAPER_PERMISSION"]
  export function skipPermissions() {
    let rules: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(process.env.BOUNTYREAPER_PERMISSION ?? "{}")
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        rules = parsed as Record<string, unknown>
    } catch {}
    rules["*"] = "allow"
    process.env.BOUNTYREAPER_PERMISSION = JSON.stringify(rules)
  }
  export const BOUNTYREAPER_DISABLE_DEFAULT_PLUGINS = truthy("BOUNTYREAPER_DISABLE_DEFAULT_PLUGINS")
  export const BOUNTYREAPER_DISABLE_LSP_DOWNLOAD = truthy("BOUNTYREAPER_DISABLE_LSP_DOWNLOAD")
  export const BOUNTYREAPER_ENABLE_EXPERIMENTAL_MODELS = truthy("BOUNTYREAPER_ENABLE_EXPERIMENTAL_MODELS")
  export const BOUNTYREAPER_DISABLE_AUTOCOMPACT = truthy("BOUNTYREAPER_DISABLE_AUTOCOMPACT")
  export const BOUNTYREAPER_DISABLE_MODELS_FETCH = truthy("BOUNTYREAPER_DISABLE_MODELS_FETCH")
  export const BOUNTYREAPER_DISABLE_CLAUDE_CODE = truthy("BOUNTYREAPER_DISABLE_CLAUDE_CODE")
  export const BOUNTYREAPER_DISABLE_CLAUDE_CODE_PROMPT =
    BOUNTYREAPER_DISABLE_CLAUDE_CODE || truthy("BOUNTYREAPER_DISABLE_CLAUDE_CODE_PROMPT")
  export const BOUNTYREAPER_DISABLE_CLAUDE_CODE_SKILLS =
    BOUNTYREAPER_DISABLE_CLAUDE_CODE || truthy("BOUNTYREAPER_DISABLE_CLAUDE_CODE_SKILLS")
  export const BOUNTYREAPER_DISABLE_EXTERNAL_SKILLS =
    BOUNTYREAPER_DISABLE_CLAUDE_CODE_SKILLS || truthy("BOUNTYREAPER_DISABLE_EXTERNAL_SKILLS")
  export declare const BOUNTYREAPER_DISABLE_PROJECT_CONFIG: boolean
  export const BOUNTYREAPER_FAKE_VCS = process.env["BOUNTYREAPER_FAKE_VCS"]
  export declare const BOUNTYREAPER_CLIENT: string
  export const BOUNTYREAPER_SERVER_PASSWORD = process.env["BOUNTYREAPER_SERVER_PASSWORD"]
  export const BOUNTYREAPER_SERVER_USERNAME = process.env["BOUNTYREAPER_SERVER_USERNAME"]

  // Experimental
  export const BOUNTYREAPER_EXPERIMENTAL = truthy("BOUNTYREAPER_EXPERIMENTAL")
  export const BOUNTYREAPER_EXPERIMENTAL_FILEWATCHER = truthy("BOUNTYREAPER_EXPERIMENTAL_FILEWATCHER")
  export const BOUNTYREAPER_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("BOUNTYREAPER_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const BOUNTYREAPER_EXPERIMENTAL_ICON_DISCOVERY =
    BOUNTYREAPER_EXPERIMENTAL || truthy("BOUNTYREAPER_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["BOUNTYREAPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const BOUNTYREAPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("BOUNTYREAPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const BOUNTYREAPER_ENABLE_EXA =
    truthy("BOUNTYREAPER_ENABLE_EXA") || BOUNTYREAPER_EXPERIMENTAL || truthy("BOUNTYREAPER_EXPERIMENTAL_EXA")
  export const BOUNTYREAPER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number(
    "BOUNTYREAPER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS",
  )
  export const BOUNTYREAPER_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("BOUNTYREAPER_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const BOUNTYREAPER_EXPERIMENTAL_OXFMT = BOUNTYREAPER_EXPERIMENTAL || truthy("BOUNTYREAPER_EXPERIMENTAL_OXFMT")
  export const BOUNTYREAPER_EXPERIMENTAL_LSP_TY = truthy("BOUNTYREAPER_EXPERIMENTAL_LSP_TY")
  export const BOUNTYREAPER_EXPERIMENTAL_LSP_TOOL =
    BOUNTYREAPER_EXPERIMENTAL || truthy("BOUNTYREAPER_EXPERIMENTAL_LSP_TOOL")
  export const BOUNTYREAPER_DISABLE_FILETIME_CHECK = truthy("BOUNTYREAPER_DISABLE_FILETIME_CHECK")
  export const BOUNTYREAPER_EXPERIMENTAL_PLAN_MODE =
    BOUNTYREAPER_EXPERIMENTAL || truthy("BOUNTYREAPER_EXPERIMENTAL_PLAN_MODE")
  export const BOUNTYREAPER_EXPERIMENTAL_MARKDOWN = truthy("BOUNTYREAPER_EXPERIMENTAL_MARKDOWN")
  export const BOUNTYREAPER_MODELS_URL = process.env["BOUNTYREAPER_MODELS_URL"]
  export const BOUNTYREAPER_MODELS_PATH = process.env["BOUNTYREAPER_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for BOUNTYREAPER_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "BOUNTYREAPER_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("BOUNTYREAPER_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for BOUNTYREAPER_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "BOUNTYREAPER_CONFIG_DIR", {
  get() {
    return process.env["BOUNTYREAPER_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for BOUNTYREAPER_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "BOUNTYREAPER_CLIENT", {
  get() {
    return process.env["BOUNTYREAPER_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})

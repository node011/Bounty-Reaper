function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

export namespace Flag {
  export const BOUNTYREPER_AUTO_SHARE = truthy("BOUNTYREPER_AUTO_SHARE")
  export const BOUNTYREPER_GIT_BASH_PATH = process.env["BOUNTYREPER_GIT_BASH_PATH"]
  export const BOUNTYREPER_CONFIG = process.env["BOUNTYREPER_CONFIG"]
  export declare const BOUNTYREPER_CONFIG_DIR: string | undefined
  export const BOUNTYREPER_CONFIG_CONTENT = process.env["BOUNTYREPER_CONFIG_CONTENT"]
  export const BOUNTYREPER_DISABLE_AUTOUPDATE = truthy("BOUNTYREPER_DISABLE_AUTOUPDATE")
  export const BOUNTYREPER_DISABLE_PRUNE = truthy("BOUNTYREPER_DISABLE_PRUNE")
  export const BOUNTYREPER_DISABLE_TERMINAL_TITLE = truthy("BOUNTYREPER_DISABLE_TERMINAL_TITLE")
  export const BOUNTYREPER_PERMISSION = process.env["BOUNTYREPER_PERMISSION"]
  export function skipPermissions() {
    let rules: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(process.env.BOUNTYREPER_PERMISSION ?? "{}")
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
        rules = parsed as Record<string, unknown>
    } catch {}
    rules["*"] = "allow"
    process.env.BOUNTYREPER_PERMISSION = JSON.stringify(rules)
  }
  export const BOUNTYREPER_DISABLE_DEFAULT_PLUGINS = truthy("BOUNTYREPER_DISABLE_DEFAULT_PLUGINS")
  export const BOUNTYREPER_DISABLE_LSP_DOWNLOAD = truthy("BOUNTYREPER_DISABLE_LSP_DOWNLOAD")
  export const BOUNTYREPER_ENABLE_EXPERIMENTAL_MODELS = truthy("BOUNTYREPER_ENABLE_EXPERIMENTAL_MODELS")
  export const BOUNTYREPER_DISABLE_AUTOCOMPACT = truthy("BOUNTYREPER_DISABLE_AUTOCOMPACT")
  export const BOUNTYREPER_DISABLE_MODELS_FETCH = truthy("BOUNTYREPER_DISABLE_MODELS_FETCH")
  export const BOUNTYREPER_DISABLE_CLAUDE_CODE = truthy("BOUNTYREPER_DISABLE_CLAUDE_CODE")
  export const BOUNTYREPER_DISABLE_CLAUDE_CODE_PROMPT =
    BOUNTYREPER_DISABLE_CLAUDE_CODE || truthy("BOUNTYREPER_DISABLE_CLAUDE_CODE_PROMPT")
  export const BOUNTYREPER_DISABLE_CLAUDE_CODE_SKILLS =
    BOUNTYREPER_DISABLE_CLAUDE_CODE || truthy("BOUNTYREPER_DISABLE_CLAUDE_CODE_SKILLS")
  export const BOUNTYREPER_DISABLE_EXTERNAL_SKILLS =
    BOUNTYREPER_DISABLE_CLAUDE_CODE_SKILLS || truthy("BOUNTYREPER_DISABLE_EXTERNAL_SKILLS")
  export declare const BOUNTYREPER_DISABLE_PROJECT_CONFIG: boolean
  export const BOUNTYREPER_FAKE_VCS = process.env["BOUNTYREPER_FAKE_VCS"]
  export declare const BOUNTYREPER_CLIENT: string
  export const BOUNTYREPER_SERVER_PASSWORD = process.env["BOUNTYREPER_SERVER_PASSWORD"]
  export const BOUNTYREPER_SERVER_USERNAME = process.env["BOUNTYREPER_SERVER_USERNAME"]

  // Experimental
  export const BOUNTYREPER_EXPERIMENTAL = truthy("BOUNTYREPER_EXPERIMENTAL")
  export const BOUNTYREPER_EXPERIMENTAL_FILEWATCHER = truthy("BOUNTYREPER_EXPERIMENTAL_FILEWATCHER")
  export const BOUNTYREPER_EXPERIMENTAL_DISABLE_FILEWATCHER = truthy("BOUNTYREPER_EXPERIMENTAL_DISABLE_FILEWATCHER")
  export const BOUNTYREPER_EXPERIMENTAL_ICON_DISCOVERY =
    BOUNTYREPER_EXPERIMENTAL || truthy("BOUNTYREPER_EXPERIMENTAL_ICON_DISCOVERY")

  const copy = process.env["BOUNTYREPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
  export const BOUNTYREPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT =
    copy === undefined ? process.platform === "win32" : truthy("BOUNTYREPER_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
  export const BOUNTYREPER_ENABLE_EXA =
    truthy("BOUNTYREPER_ENABLE_EXA") || BOUNTYREPER_EXPERIMENTAL || truthy("BOUNTYREPER_EXPERIMENTAL_EXA")
  export const BOUNTYREPER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = number(
    "BOUNTYREPER_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS",
  )
  export const BOUNTYREPER_EXPERIMENTAL_OUTPUT_TOKEN_MAX = number("BOUNTYREPER_EXPERIMENTAL_OUTPUT_TOKEN_MAX")
  export const BOUNTYREPER_EXPERIMENTAL_OXFMT = BOUNTYREPER_EXPERIMENTAL || truthy("BOUNTYREPER_EXPERIMENTAL_OXFMT")
  export const BOUNTYREPER_EXPERIMENTAL_LSP_TY = truthy("BOUNTYREPER_EXPERIMENTAL_LSP_TY")
  export const BOUNTYREPER_EXPERIMENTAL_LSP_TOOL =
    BOUNTYREPER_EXPERIMENTAL || truthy("BOUNTYREPER_EXPERIMENTAL_LSP_TOOL")
  export const BOUNTYREPER_DISABLE_FILETIME_CHECK = truthy("BOUNTYREPER_DISABLE_FILETIME_CHECK")
  export const BOUNTYREPER_EXPERIMENTAL_PLAN_MODE =
    BOUNTYREPER_EXPERIMENTAL || truthy("BOUNTYREPER_EXPERIMENTAL_PLAN_MODE")
  export const BOUNTYREPER_EXPERIMENTAL_MARKDOWN = truthy("BOUNTYREPER_EXPERIMENTAL_MARKDOWN")
  export const BOUNTYREPER_MODELS_URL = process.env["BOUNTYREPER_MODELS_URL"]
  export const BOUNTYREPER_MODELS_PATH = process.env["BOUNTYREPER_MODELS_PATH"]

  function number(key: string) {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
}

// Dynamic getter for BOUNTYREPER_DISABLE_PROJECT_CONFIG
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "BOUNTYREPER_DISABLE_PROJECT_CONFIG", {
  get() {
    return truthy("BOUNTYREPER_DISABLE_PROJECT_CONFIG")
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for BOUNTYREPER_CONFIG_DIR
// This must be evaluated at access time, not module load time,
// because external tooling may set this env var at runtime
Object.defineProperty(Flag, "BOUNTYREPER_CONFIG_DIR", {
  get() {
    return process.env["BOUNTYREPER_CONFIG_DIR"]
  },
  enumerable: true,
  configurable: false,
})

// Dynamic getter for BOUNTYREPER_CLIENT
// This must be evaluated at access time, not module load time,
// because some commands override the client at runtime
Object.defineProperty(Flag, "BOUNTYREPER_CLIENT", {
  get() {
    return process.env["BOUNTYREPER_CLIENT"] ?? "cli"
  },
  enumerable: true,
  configurable: false,
})

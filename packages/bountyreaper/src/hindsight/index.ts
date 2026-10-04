import { HindsightClient, HindsightError } from "@vectorize-io/hindsight-client"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Auth } from "@/auth"

const log = Log.create({ service: "hindsight" })

// Hindsight Cloud integration — long-term agent memory that learns.
// Key resolution order:
//   1. HINDSIGHT_API_KEY      (env, wins — CI/ephemeral)
//   2. auth.json "hindsight"  (written by the /hindsight setup flow)
// Optional:
//   HINDSIGHT_BASE_URL        default https://api.hindsight.vectorize.io
//   HINDSIGHT_BANK_PREFIX     default "bountyreaper"
// Absent/unreachable Hindsight is a no-op: built-in file memory keeps working.

export namespace Hindsight {
  const BASE_URL = process.env.HINDSIGHT_BASE_URL ?? "https://api.hindsight.vectorize.io"
  const BANK_PREFIX = process.env.HINDSIGHT_BANK_PREFIX ?? "bountyreaper"
  /** Pseudo-provider id under which the key is stored in auth.json. */
  export const AUTH_ID = "hindsight"

  let client: HindsightClient | undefined
  let unhealthyUntil = 0
  const FAILURE_COOLDOWN_MS = 60_000

  export function envKey(): string | undefined {
    const k = process.env.HINDSIGHT_API_KEY?.trim()
    return k && k.length > 8 ? k : undefined
  }

  /** Stored key from the /hindsight setup flow, or undefined. */
  export async function storedKey(): Promise<string | undefined> {
    const info = await Auth.get(AUTH_ID).catch(() => undefined)
    if (info?.type !== "api") return undefined
    const k = info.key.trim()
    return k.length > 8 ? k : undefined
  }

  let cached: string | undefined
  async function resolve(): Promise<string | undefined> {
    return envKey() ?? (cached ??= await storedKey())
  }

  /** Sync key access for callers outside an async context (registry gating). */
  export function key(): string | undefined {
    return envKey() ?? cached
  }

  /** Populates the cached stored key; call once during startup. */
  export async function init(): Promise<void> {
    cached = envKey() ?? (await storedKey())
    if (cached) log.info("hindsight enabled", { bank: bank() })
  }

  async function client_for(): Promise<HindsightClient | undefined> {
    const k = await resolve()
    if (!k) return undefined
    if (Date.now() < unhealthyUntil) return undefined
    if (client) return client
    client = new HindsightClient({ baseUrl: BASE_URL, apiKey: k })
    return client
  }

  function fail(err: unknown) {
    unhealthyUntil = Date.now() + FAILURE_COOLDOWN_MS
    client = undefined
    if (err instanceof HindsightError) log.warn("hindsight call failed", { status: err.statusCode })
    else log.warn("hindsight call failed", { err: String(err).slice(0, 120) })
  }

  /**
   * Per-project bank, so memory carries across sessions — the whole point of
   * long-term memory. `Instance.project` THROWS when no instance context is
   * active (it does not return undefined), hence the guarded read; without it a
   * retain outside a session would crash instead of degrading.
   */
  export function bank(): string {
    let scope = "global"
    try {
      scope = Instance.project?.id || "global"
    } catch {}
    return `${BANK_PREFIX}-${scope}`
  }

  /**
   * Fire-and-forget retain. Resolves to whether the memory was actually
   * accepted — callers MUST NOT report success on `false`, or the agent gets
   * told a memory was stored when it was silently dropped.
   */
  export async function retain(content: string, context?: string, tags?: string[]): Promise<boolean> {
    const c = await client_for()
    if (!c) return false
    try {
      await c.retain(bank(), content.slice(0, 16_000), {
        ...(context ? { context } : {}),
        ...(tags?.length ? { tags } : {}),
        async: true,
      })
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  /** Recall relevant memories. Returns formatted text or undefined. */
  export async function recall(query: string, maxTokens = 2000): Promise<string | undefined> {
    const c = await client_for()
    if (!c) return undefined
    try {
      const res = await c.recall(bank(), query, { maxTokens })
      if (!res.results?.length) return undefined
      return res.results.map((r) => `- ${r.text}${r.context ? ` (${r.context})` : ""}`).join("\n")
    } catch (err) {
      fail(err)
      return undefined
    }
  }

  /** Reflect = disposition-aware deep synthesis over the bank. */
  export async function reflect(query: string): Promise<string | undefined> {
    const c = await client_for()
    if (!c) return undefined
    try {
      const res = await c.reflect(bank(), query)
      return res.text || undefined
    } catch (err) {
      fail(err)
      return undefined
    }
  }

  /** True when a key is resolved (env or stored) AND the API is not in cooldown. */
  export function configured(): boolean {
    return Boolean(key()) && Date.now() >= unhealthyUntil
  }

  export function enabled(): boolean {
    return Boolean(key())
  }
}
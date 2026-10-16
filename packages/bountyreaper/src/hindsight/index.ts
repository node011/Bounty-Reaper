import { HindsightClient, HindsightError } from "@vectorize-io/hindsight-client"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { Auth } from "@/auth"

const log = Log.create({ service: "hindsight" })

// Hindsight — long-term agent memory that learns.
// Deployment precedence:
//   1. HINDSIGHT_BASE_URL env (operator chooses any endpoint; wins always)
//   2. HINDSIGHT_LOCAL=1   → force local http://localhost:8888
//   3. cloud key present   → https://api.hindsight.vectorize.io (legacy /hindsight flow)
//   4. default             → LOCAL docker (docker-compose.yml ships with the project;
//                            `bun script/hindsight.ts up` on a new system — no API key)
// Key resolution (cloud-only requirement):
//   1. HINDSIGHT_API_KEY      (env, wins — CI/ephemeral)
//   2. auth.json "hindsight"  (written by the /hindsight setup flow)
// Optional: HINDSIGHT_BANK_PREFIX (default "bountyreaper")
// Unreachable/absent Hindsight is a no-op: built-in file memory keeps working.

export namespace Hindsight {
  export const CLOUD_URL = "https://api.hindsight.vectorize.io"
  export const LOCAL_URL = process.env.HINDSIGHT_LOCAL_URL ?? "http://localhost:8888"
  const BANK_PREFIX = process.env.HINDSIGHT_BANK_PREFIX ?? "bountyreaper"
  /** Pseudo-provider id under which a cloud key is stored in auth.json. */
  export const AUTH_ID = "hindsight"

  const PROJECT_MODEL_NAME = "project-durable"
  const PROJECT_MODEL_QUERY =
    "Durable knowledge from past hunting sessions on this project: targets and their " +
    "attack-surface conclusions, confirmed findings and their patterns, what worked and " +
    "what failed, workflow conventions, and reusable lessons. Exclude credentials and secrets."

  let client: HindsightClient | undefined
  let unhealthyUntil = 0
  let probed = false
  const FAILURE_COOLDOWN_MS = 60_000

  export function envKey(): string | undefined {
    const k = process.env.HINDSIGHT_API_KEY?.trim()
    return k && k.length > 8 ? k : undefined
  }

  /** Stored cloud key from the /hindsight setup flow, or undefined. */
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

  let baseURL = process.env.HINDSIGHT_BASE_URL ?? LOCAL_URL
  /** Effective endpoint (resolved by init(); LOCAL_URL until then). */
  export function baseUrl(): string {
    return baseURL
  }

  function isLocal(url: string): boolean {
    return url.includes("//localhost") || url.includes("//127.0.0.1") || url.includes("host.docker.internal")
  }

  /** Populates the endpoint+key cache; call once during startup. */
  export async function init(): Promise<void> {
    cached = envKey() ?? (await storedKey())
    // LOCAL IS THE DEFAULT MEMORY — period. A stored cloud key must NOT silently flip
    // the endpoint to cloud (that legacy precedence would re-route an operator who
    // migrated to local straight back to the vendor). Precedence:
    //   1. HINDSIGHT_LOCAL=1      → force the shipped local endpoint
    //   2. HINDSIGHT_BASE_URL     → operator-chosen endpoint (cloud is opt-in here)
    //   3. default                → local http://localhost:8888
    baseURL =
      process.env.HINDSIGHT_LOCAL === "1"
        ? LOCAL_URL
        : (process.env.HINDSIGHT_BASE_URL ?? LOCAL_URL)
    const active = key() || isLocal(baseURL)
    if (active && !probed) {
      probed = true
      // One-time reachability probe so an offline local container is detected at
      // boot instead of on every tool call — tools then report the honest
      // "not reachable — run bun script/hindsight.ts up" state for the cooldown.
      const res = await new HindsightClient({
        baseUrl: baseURL,
        ...(key() ? { apiKey: key() } : {}),
      })
        .getVersion()
        .then(() => true, () => false)
        .catch(() => false)
      if (!res) {
        log.warn("hindsight endpoint unreachable — run: bun script/hindsight.ts up", { base: baseURL })
        fail(new Error("hindsight endpoint unreachable at startup"))
        return
      }
      log.info("hindsight enabled", { base: baseURL, bank: bank() })
      // Fire-and-forget: the curated standing document must exist before the next
      // session looks for it; failure is never fatal (tool layer still works).
      ensureMentalModel().catch(() => {})
    }
  }

  async function client_for(): Promise<HindsightClient | undefined> {
    // Local deployments need no key; cloud does. Both use the same client.
    const k = await resolve()
    if (!k && !isLocal(baseURL)) return undefined
    if (Date.now() < unhealthyUntil) return undefined
    if (client) return client
    client = new HindsightClient({ baseUrl: baseURL, ...(k ? { apiKey: k } : {}) })
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

  /**
   * The newest LESSONS (tagged by hindsight_learn), newest-first, as raw fact lines.
   * Feeds the auto-skill compilation — the omp learn→managed-skill pipeline.
   */
  export async function lessons(limit = 60): Promise<string[] | undefined> {
    const c = await client_for()
    if (!c) return undefined
    try {
      const res = await c.recall(bank(), "lesson", { tags: ["lesson"], maxTokens: 6000 })
      const lines = (res.results ?? []).map((r) => r.text.trim()).filter(Boolean)
      return lines.length ? lines.slice(0, limit) : undefined
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

  /** True when this session can use Hindsight right now. Local needs no key but must
   * have passed the startup probe; cloud needs both a key and health. */
  export function configured(): boolean {
    if (Date.now() < unhealthyUntil) return false
    return isLocal(baseURL) ? true : Boolean(key())
  }

  export function enabled(): boolean {
    return Boolean(key()) || isLocal(baseURL)
  }

  /**
   * Called on init() success, once, idempotently. Creates the per-project mental model
   * (omp-style session curation: the bank compresses everything it learns into ONE
   * standing document that the next session reads on its first turn). The refresh is
   * SERVER-DECLARATIVE — after each consolidation cycle, delta-edited with a floor of
   * 30 min so a burst of retains costs one refresh, not one per retain. Never throws.
   */
  let mmEnsured = false

  export async function ensureMentalModel(): Promise<void> {
    // In-process guard: init() and startup paths may both reach here — without the
    // flag a name-check race (create vs create) yields duplicate standing documents.
    if (mmEnsured) return
    mmEnsured = true
    const c = await client_for()
    if (!c) return
    try {
      const existing = await c.listMentalModels(bank(), { detail: "metadata", limit: 100 })
      if (!existing.items?.some((m: { name?: string }) => m.name === PROJECT_MODEL_NAME)) {
        await c.createMentalModel(bank(), PROJECT_MODEL_NAME, PROJECT_MODEL_QUERY, {
          maxTokens: 1500,
          trigger: { refreshAfterConsolidation: true, mode: "delta", minRefreshIntervalSeconds: 1800 },
        })
        // Startup convenience: the refresh trigger only fires on consolidation, so a
        // fresh bank would boot with an empty document until that happens. Fire one
        // manual refresh now (async op server-side) so the first session gets a
        // populated settled-knowledge page. Never fatal.
        const res = await c
          .listMentalModels(bank(), { detail: "metadata", limit: 100 })
          .then((r) => r.items?.find((m: { name?: string }) => m.name === PROJECT_MODEL_NAME))
        if (res?.id) await c.refreshMentalModel(bank(), res.id).catch(() => {})
        log.info("hindsight mental model created", { bank: bank() })
      }
    } catch (err) {
      log.warn("hindsight mental model setup skipped", { err: String(err).slice(0, 120) })
    }
  }

  /**
   * The settle-knowledge document (omp's "loads on the first turn of the next one").
   * A pure database READ on the server: no retrieval, no LLM call, no latency tax.
   */
  export async function mentalModel(maxTokens = 3000): Promise<string | undefined> {
    const c = await client_for()
    if (!c) return undefined
    try {
      const list = await c.listMentalModels(bank(), { detail: "metadata", limit: 100 })
      const found = list.items?.find((m: { name?: string; id?: string }) => m.name === PROJECT_MODEL_NAME)
      if (!found?.id) return undefined
      const resp = await c.getMentalModel(bank(), found.id, { detail: "content" })
      const text = (resp as { content?: string }).content?.trim()
      if (!text) return undefined
      return text.slice(0, maxTokens * 4)
    } catch (err) {
      log.warn("hindsight mental model read failed", { err: String(err).slice(0, 120) })
      return undefined
    }
  }

  /** Capture a reusable LESSON (omp learn): a distilled pattern, not a raw fact. */
  export async function learn(content: string, tags?: string[]): Promise<boolean> {
    return retain(
      content.slice(0, 16_000),
      "lesson",
      ["lesson", ...(tags ?? [])],
    )
  }

  /**
   * Curation by id (omp memory_edit):
   *  - action "update"    → replace the fact text (re-embeds, re-consolidates)
   *  - action "forget"    → soft-retire: excluded from recall/consolidation, archived
   *  - action "revalidate"→ undo a forget
   * All reversible. Uses the REST PATCH surface the client prototype lacks.
   */
  export async function memoryEdit(
    memoryId: string,
    action: "update" | "forget" | "revalidate",
    patch: { text?: string; reason?: string } = {},
  ): Promise<boolean> {
    const c = await client_for()
    if (!c) return false
    if (action === "update" && !(patch.text?.trim() ?? "").length) {
      fail(new Error("memory edit: action=update requires text"))
      return false
    }
    const body =
      action === "update"
        ? { text: patch.text!.trim().slice(0, 16_000), reason: patch.reason ?? null }
        : action === "forget"
          ? { state: "invalidated", reason: patch.reason ?? "forgotten by operator/agent curation" }
          : { state: "valid", reason: patch.reason ?? null }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    const k = await resolve()
    if (k && !isLocal(baseURL)) headers.Authorization = `Bearer ${k}`
    try {
      const res = await fetch(`${baseURL}/v1/default/banks/${bank()}/memories/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new HindsightError(`memory edit failed: ${res.status}`, res.status)
      return true
    } catch (err) {
      fail(err)
      return false
    }
  }

  /** Test hook only: clears the one-time probe / key / endpoint caches between tests. */
  export function resetForTests(): void {
    cached = undefined
    client = undefined
    probed = false
    unhealthyUntil = 0
    baseURL = LOCAL_URL
  }
}
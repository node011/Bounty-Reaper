import { Database, eq, and } from "../storage/db"
import { ChainCandidateTable } from "./methodology.sql"
import { Identifier } from "../id/id"
import { Intel } from "./intel"

// ============================================================
// CHAIN DETECTION ENGINE — 8 vulnerability chain patterns
// Detects when multiple low-severity findings combine into
// high-impact exploitation chains
// ============================================================

export namespace Chain {
  export type Pattern =
    | "credential_endpoint"
    | "info_disclosure_ssrf"
    | "redirect_oauth"
    | "idor_data_leak"
    | "xss_csrf"
    | "ssti_rce"
    | "race_condition_business"
    | "custom"

  /**
   * Chain proof model — a combination of findings may only be treated as an
   * exploit path (and have its severity elevated) when EVERY gate below is
   * proven. "Could be chained" without proof is a potential chain, not a
   * finding. Ported discipline: exploit-chainer "validate each link".
   */
  export interface ChainProof {
    /** Each individual finding in the chain is independently confirmed. */
    prerequisiteOk?: boolean
    /** The attacker can actually traverse from finding A to finding B. */
    reachabilityOk?: boolean
    /** Tokens, roles, network paths and timing actually align across hops. */
    compatibilityOk?: boolean
    /** Final impact demonstrated with a minimal, safe proof. */
    impactDemonstrated?: boolean
    /** Refutation attempted (controls/boundary checks tried to disprove the chain). */
    refutationAttempted?: boolean
    /** Per-hop evidence trail. */
    hops?: Array<{ from: string; to: string; verified: boolean; evidence?: string }>
    notes?: string
    updatedAt?: number
  }

  export interface Candidate {
    id: string
    pattern: Pattern
    entryIDs: string[]
    entryTitles: string[]
    assets: string[]
    expectedImpact: string
    severity: string
    testingPlan: string
    status: "detected" | "testing" | "confirmed" | "disproven"
    confidence: number
    proof?: ChainProof
    detectedAt: number
  }

  const PROOF_GATES: Array<{ key: keyof ChainProof; label: string }> = [
    { key: "prerequisiteOk", label: "prerequisite (each finding confirmed)" },
    { key: "reachabilityOk", label: "reachability (A -> B traversable)" },
    { key: "compatibilityOk", label: "compatibility (tokens/roles/network/timing align)" },
    { key: "impactDemonstrated", label: "impact (final impact demonstrated, minimal safe proof)" },
    { key: "refutationAttempted", label: "refutation (attempted to disprove the chain)" },
  ]

  export function proofComplete(proof?: ChainProof): boolean {
    if (!proof) return false
    return PROOF_GATES.every((g) => proof[g.key] === true)
  }

  export function missingProofGates(proof?: ChainProof): string[] {
    return PROOF_GATES.filter((g) => proof?.[g.key] !== true).map((g) => g.label)
  }

  const OAUTH_REGEX = /\b(oauth|authorize|callback|redirect_uri|token|sso|saml|openid)\b/i
  const STATE_CHANGE_REGEX = /\b(POST|PUT|DELETE|PATCH|create|update|delete|transfer|payment|invite|admin)\b/i
  const USER_DATA_REGEX = /\b(user|profile|account|email|phone|address|personal|private|settings)\b/i
  const PAYMENT_REGEX = /\b(payment|transfer|order|checkout|cart|purchase|balance|credit|withdraw|deposit)\b/i

  // --- Detection ---

  export function detect(sessionID: string): Candidate[] {
    const entries = Intel.get(sessionID)
    if (entries.length < 2) return []

    const checks = Intel.getVrtChecks(sessionID)
    const checkMap = new Map<string, Array<{ category: string; status: string }>>()
    for (const check of checks) {
      if (!checkMap.has(check.entryID)) checkMap.set(check.entryID, [])
      checkMap.get(check.entryID)!.push({ category: check.category, status: check.status })
    }

    const hasVulnCheck = (entry: Intel.Entry, cat: string) =>
      (checkMap.get(entry.id) ?? []).some(
        (c) => c.category.toLowerCase().includes(cat.toLowerCase()) && c.status === "tested_vulnerable",
      )

    const sameAssetOrRelated = (a: Intel.Entry, b: Intel.Entry) => {
      const aa = a.asset.toLowerCase()
      const ba = b.asset.toLowerCase()
      if (aa === ba) return true
      const domainA = aa.split(".").slice(-2).join(".")
      const domainB = ba.split(".").slice(-2).join(".")
      return domainA === domainB
    }

    const chains: Candidate[] = []
    const seen = new Set<string>()

    const addChain = (
      pattern: Pattern,
      a: Intel.Entry,
      b: Intel.Entry,
      impact: string,
      sev: string,
      plan: string,
      conf: number,
    ) => {
      const key = `${pattern}:${[a.id, b.id].sort().join("+")}`
      if (seen.has(key)) return
      seen.add(key)
      chains.push({
        id: Identifier.ascending("chain_candidate"),
        pattern,
        entryIDs: [a.id, b.id],
        entryTitles: [a.title, b.title],
        assets: [...new Set([a.asset, b.asset])],
        expectedImpact: impact,
        severity: sev,
        testingPlan: plan,
        status: "detected",
        confidence: conf,
        detectedAt: Date.now(),
      })
    }

    const credentials = entries.filter((e) => e.type === "credential")
    const endpoints = entries.filter((e) => e.type === "endpoint")
    const services = entries.filter((e) => e.type === "configuration" || e.type === "infrastructure")

    // 1. credential_endpoint: Credential + API endpoint = ATO
    for (const cred of credentials) {
      for (const ep of endpoints) {
        if (!sameAssetOrRelated(cred, ep)) continue
        if (ep.severity === "info") continue
        const conf = cred.status === "exploited" ? 90 : cred.confidenceLevel === "confirmed" ? 85 : 65
        addChain(
          "credential_endpoint",
          cred,
          ep,
          "ACCOUNT_TAKEOVER",
          "critical",
          `Use credential "${cred.title}" to authenticate against "${ep.title}"`,
          conf,
        )
      }
    }

    // 2. info_disclosure_ssrf: Info disclosure + SSRF-testable endpoint
    for (const info of services) {
      for (const ep of endpoints) {
        if (!sameAssetOrRelated(info, ep)) continue
        const hasSsrf = (checkMap.get(ep.id) ?? []).some((c) => c.category.toLowerCase().includes("ssrf"))
        if (!hasSsrf) continue
        const conf = hasVulnCheck(ep, "ssrf") ? 90 : 55
        addChain(
          "info_disclosure_ssrf",
          info,
          ep,
          "SSRF_TO_INTERNAL",
          "high",
          `Use internal URL/config from "${info.title}" as SSRF target via "${ep.title}"`,
          conf,
        )
      }
    }

    // 3. redirect_oauth: Open redirect + OAuth endpoint
    for (const a of entries) {
      if (!hasVulnCheck(a, "redirect") && !hasVulnCheck(a, "open redirect")) continue
      for (const b of entries) {
        if (a.id === b.id) continue
        if (!sameAssetOrRelated(a, b)) continue
        const text = `${b.title} ${b.detail ?? ""}`
        if (!OAUTH_REGEX.test(text)) continue
        addChain(
          "redirect_oauth",
          a,
          b,
          "TOKEN_THEFT",
          "critical",
          `Chain open redirect from "${a.title}" into OAuth flow at "${b.title}" to steal access_token`,
          80,
        )
      }
    }

    // 4. idor_data_leak: IDOR + user data endpoint
    for (const a of entries) {
      if (!hasVulnCheck(a, "idor")) continue
      for (const b of endpoints) {
        if (a.id === b.id) continue
        if (!sameAssetOrRelated(a, b)) continue
        const text = `${b.title} ${b.detail ?? ""}`
        if (!USER_DATA_REGEX.test(text)) continue
        addChain(
          "idor_data_leak",
          a,
          b,
          "MASS_DATA_LEAK",
          "critical",
          `Use IDOR from "${a.title}" to enumerate user data via "${b.title}"`,
          85,
        )
      }
    }

    // 5. xss_csrf: XSS + state-changing endpoint
    for (const a of entries) {
      if (!hasVulnCheck(a, "xss")) continue
      for (const b of endpoints) {
        if (a.id === b.id) continue
        if (!sameAssetOrRelated(a, b)) continue
        const text = `${b.title} ${b.detail ?? ""}`
        if (!STATE_CHANGE_REGEX.test(text)) continue
        addChain(
          "xss_csrf",
          a,
          b,
          "CSRF_BYPASS",
          "high",
          `Use XSS from "${a.title}" to perform CSRF on state-changing "${b.title}"`,
          75,
        )
      }
    }

    // 6. ssti_rce: SSTI → RCE
    for (const a of entries) {
      if (!hasVulnCheck(a, "ssti")) continue
      addChain(
        "ssti_rce",
        a,
        a,
        "RCE",
        "critical",
        `Escalate SSTI in "${a.title}" to full RCE via template engine gadgets`,
        85,
      )
    }

    // 7. race_condition_business: Race + payment/transfer
    for (const a of entries) {
      if (!hasVulnCheck(a, "race")) continue
      for (const b of endpoints) {
        if (a.id === b.id) continue
        if (!sameAssetOrRelated(a, b)) continue
        const text = `${b.title} ${b.detail ?? ""}`
        if (!PAYMENT_REGEX.test(text)) continue
        addChain(
          "race_condition_business",
          a,
          b,
          "FINANCIAL_IMPACT",
          "critical",
          `Use race condition from "${a.title}" on financial endpoint "${b.title}" for double-spend/bypass`,
          80,
        )
      }
    }

    // 8. custom: Entries with explicit chainPotential or relatedEntries
    for (const a of entries) {
      if (!a.chainPotential && a.relatedEntries.length === 0) continue
      for (const relId of a.relatedEntries) {
        const b = entries.find((e) => e.id === relId)
        if (!b) continue
        addChain(
          "custom",
          a,
          b,
          "ESCALATION",
          a.severity ?? "medium",
          a.chainPotential ?? `Chain "${a.title}" with "${b.title}"`,
          60,
        )
      }
    }

    chains.sort((a, b) => b.confidence - a.confidence)
    return chains
  }

  // --- Persistence ---

  export function save(sessionID: string, chains: Candidate[]): void {
    // Load existing to preserve status
    const existing = load(sessionID)
    const existingMap = new Map(existing.map((c) => [`${c.pattern}:${c.entryIDs.sort().join("+")}`, c]))

    Database.use((db) => {
      // Clear old chains for this session
      db.delete(ChainCandidateTable).where(eq(ChainCandidateTable.session_id, sessionID)).run()

      const now = Date.now()
      for (const chain of chains) {
        const key = `${chain.pattern}:${chain.entryIDs.sort().join("+")}`
        const prev = existingMap.get(key)

        db.insert(ChainCandidateTable)
          .values({
            id: prev?.id ?? chain.id,
            session_id: sessionID,
            pattern: chain.pattern,
            entry_ids: chain.entryIDs as any,
            entry_titles: chain.entryTitles as any,
            assets: chain.assets as any,
            expected_impact: chain.expectedImpact,
            severity: chain.severity,
            testing_plan: chain.testingPlan,
            status: prev?.status ?? chain.status,
            confidence: chain.confidence,
            proof: (prev?.proof ?? chain.proof ?? null) as any,
            detected_at: chain.detectedAt,
            time_created: now,
            time_updated: now,
          })
          .run()
      }
    })
  }

  export function load(sessionID: string): Candidate[] {
    const rows = Database.use((db) =>
      db.select().from(ChainCandidateTable).where(eq(ChainCandidateTable.session_id, sessionID)).all(),
    )
    return rows.map((r) => ({
      id: r.id,
      pattern: r.pattern as Pattern,
      entryIDs: (r.entry_ids as string[]) ?? [],
      entryTitles: (r.entry_titles as string[]) ?? [],
      assets: (r.assets as string[]) ?? [],
      expectedImpact: r.expected_impact ?? "",
      severity: r.severity ?? "medium",
      testingPlan: r.testing_plan ?? "",
      status: r.status as Candidate["status"],
      confidence: r.confidence,
      proof: (r.proof as ChainProof | null) ?? undefined,
      detectedAt: r.detected_at ?? r.time_created,
    }))
  }

  /**
   * Record proof progress for a chain. A chain may only be marked "confirmed"
   * when ALL proof gates pass; otherwise the status is held at/below "testing"
   * (an over-claimed confirmation is downgraded back to testing).
   */
  export function recordProof(
    sessionID: string,
    chainID: string,
    input: Partial<ChainProof>,
  ): { candidate?: Candidate; verdict: string } {
    return Database.use((db) => {
      const row = db
        .select()
        .from(ChainCandidateTable)
        .where(and(eq(ChainCandidateTable.session_id, sessionID), eq(ChainCandidateTable.id, chainID)))
        .get()
      if (!row) return { verdict: `chain not found: ${chainID}` }

      const prevProof = (row.proof as ChainProof | null) ?? {}
      const proof: ChainProof = { ...prevProof, ...input, updatedAt: Date.now() }
      const complete = proofComplete(proof)
      const nextStatus = complete
        ? "confirmed"
        : row.status === "confirmed"
          ? "testing" // downgrade an over-claimed confirmation
          : row.status

      db.update(ChainCandidateTable)
        .set({ proof: proof as any, status: nextStatus, time_updated: Date.now() })
        .where(eq(ChainCandidateTable.id, chainID))
        .run()

      const updated = load(sessionID).find((c) => c.id === chainID)
      const missing = missingProofGates(proof)
      const verdict = complete
        ? "CONFIRMED — all proof gates passed; severity elevation is justified."
        : `POTENTIAL CHAIN — UNVERIFIED. Missing gates: ${missing.join("; ")}. Do not elevate severity until proven.`
      return { candidate: updated, verdict }
    })
  }

  export function detectAndPersist(sessionID: string): Candidate[] {
    const chains = detect(sessionID)
    save(sessionID, chains)
    return chains
  }

  // --- Prompt Formatting ---

  export function formatForPrompt(chains: Candidate[]): string {
    const active = chains.filter((c) => c.status === "detected" || c.status === "testing")
    if (active.length === 0) return ""

    const lines: string[] = [`## Chain Opportunities (${active.length} detected)`]
    for (const c of active.slice(0, 10)) {
      const confLabel = c.confidence >= 80 ? "HIGH" : c.confidence >= 60 ? "MED" : "LOW"
      lines.push(
        `[${confLabel}-${c.confidence}%] ${c.pattern.toUpperCase()}: "${c.entryTitles[0]}" + "${c.entryTitles[1]}" -> ${c.expectedImpact}`,
      )
      lines.push(`  Test: ${c.testingPlan}`)
      lines.push(`  Entries: ${c.entryIDs.join(", ")} | Assets: ${c.assets.join(", ")} | id=${c.id}`)
      if (proofComplete(c.proof)) {
        lines.push("  Proof: COMPLETE — severity elevation justified")
      } else {
        lines.push(
          `  Proof: UNVERIFIED (missing: ${missingProofGates(c.proof).join("; ")}) — record via chain_proof before elevating severity`,
        )
      }
    }
    return lines.join("\n")
  }
}

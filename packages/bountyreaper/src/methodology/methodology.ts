import { Database, eq, and } from "../storage/db"
import { IntelEntryTable, MethodologyPhaseTable, ValidationViolationTable } from "./methodology.sql"
import { Identifier } from "../id/id"
import { Phase } from "./phase"
import { SkillLoad } from "./skill-load"
import { Engagement } from "./engagement"
import { CoverageNote } from "../session/coverage-note"

// ============================================================
// METHODOLOGY ENGINE — Phase tracking, prereq validation,
// violation generation, prompt formatting
// ============================================================

export namespace Methodology {
  export interface PhaseState {
    id: Phase.Id
    name: string
    status: Phase.Status
    deliverableCount: number
    evidence: string
    blockReason?: string
  }

  export interface State {
    phases: PhaseState[]
    completedCount: number
    totalCount: number
    completionPercent: number
    currentPhase?: Phase.Id
    violations: ViolationInfo[]
  }

  export interface ViolationInfo {
    gate: string
    severity: "blocking" | "warning"
    message: string
    affectedAsset?: string
    field?: string
  }

  // --- Phase State Computation ---

  export function computeState(sessionID: string): State {
    const entries = Database.use((db) =>
      db.select().from(IntelEntryTable).where(eq(IntelEntryTable.session_id, sessionID)).all(),
    )

    const scopeItems = entries
      .filter((e) => e.type === "subdomain" || ((e.tags as string[]) || []).includes("scope"))
      .map((e) => e.asset)
    const scopeType = Phase.detectScopeType(scopeItems.length > 0 ? scopeItems : entries.map((e) => e.asset))
    const applicablePhases = Phase.forScope(scopeType)

    const phases: PhaseState[] = applicablePhases.map((def) => {
      const result = validateDeliverables(def, entries, sessionID)
      const prereqCheck = checkPrerequisites(def, applicablePhases, entries, sessionID)

      const status: Phase.Status = result.completed
        ? "completed"
        : !prereqCheck.canStart
          ? "blocked"
          : result.deliverableCount > 0
            ? "in_progress"
            : "not_started"

      return {
        id: def.id,
        name: def.name,
        status,
        deliverableCount: result.deliverableCount,
        evidence: result.evidence,
        blockReason: prereqCheck.canStart ? undefined : prereqCheck.reason,
      }
    })

    // Persist phase state
    persistPhases(sessionID, phases)

    const completedCount = phases.filter((p) => p.status === "completed").length
    const totalCount = phases.length
    const current = phases.find((p) => p.status === "in_progress") ?? phases.find((p) => p.status === "not_started")

    const violations = generateViolations(sessionID, entries, phases, scopeType)

    return {
      phases,
      completedCount,
      totalCount,
      completionPercent: totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0,
      currentPhase: current?.id,
      violations,
    }
  }

  function validateDeliverables(
    def: Phase.Definition,
    entries: Array<typeof IntelEntryTable.$inferSelect>,
    sessionID: string,
  ): { completed: boolean; evidence: string; deliverableCount: number } {
    const matching = entries.filter((e) => {
      const tags = (e.tags as string[]) ?? []
      const title = (e.title || "").toLowerCase()
      return def.requiredTags.some(
        (tag) => tags.includes(tag) || title.includes(tag.replace(/-/g, " ")) || title.includes(tag),
      )
    })

    if (matching.length >= def.minDeliverables && matching.length > 0)
      return applyGates(
        def,
        {
          completed: true,
          evidence: `${matching.length} entries with required tags`,
          deliverableCount: matching.length,
        },
        sessionID,
      )

    // Optional phases (minDeliverables=0) are complete when nothing is
    // required of them — otherwise a clean target with zero findings in an
    // optional phase (e.g. business_logic) would deadlock `reporting`,
    // which lists it as a prerequisite.
    if (def.minDeliverables === 0 && matching.length === 0)
      return applyGates(
        def,
        { completed: true, evidence: "optional phase, no deliverables required", deliverableCount: 0 },
        sessionID,
      )

    return {
      completed: false,
      evidence:
        matching.length > 0
          ? `${matching.length}/${def.minDeliverables} deliverables`
          : `No entries with tags: ${def.requiredTags.join(", ")}`,
      deliverableCount: matching.length,
    }
  }

  /**
   * Post-deliverable gates (applied only when the deliverable check passed):
   *  1. Engagement gate — active-testing phases require a recorded ROE.
   *  2. Skill gate — phases with requiredSkills need ≥1 matching loaded skill.
   *     Required phases (minDeliverables > 0) are completion-blocked; optional
   *     phases keep completion and are surfaced as violations instead, so a
   *     missing skill cannot deadlock the reporting prerequisite chain.
   */
  function applyGates(
    def: Phase.Definition,
    base: { completed: boolean; evidence: string; deliverableCount: number },
    sessionID: string,
  ): { completed: boolean; evidence: string; deliverableCount: number } {
    if (!base.completed) return base

    // Placeholder completion: an optional phase with ZERO deliverables is not
    // "active testing" — let it complete untouched so an untouched clean
    // target never deadlocks the reporting prerequisite chain. Gates apply
    // as soon as the phase has real activity (deliverables > 0).
    if (def.minDeliverables === 0 && base.deliverableCount === 0) return base

    if (def.requiresEngagement && !Engagement.get(sessionID)) {
      return {
        completed: false,
        evidence: `${base.evidence}; engagement not recorded — run engagement_setup`,
        deliverableCount: base.deliverableCount,
      }
    }

    const skillGate = SkillLoad.satisfied(def, sessionID)
    if (!skillGate.ok && def.minDeliverables > 0) {
      return {
        completed: false,
        evidence: `${base.evidence}; no methodology skill loaded (expected one matching: ${skillGate.expected.join(", ")}) — use skill(action=load)`,
        deliverableCount: base.deliverableCount,
      }
    }

    return base
  }

  function checkPrerequisites(
    def: Phase.Definition,
    applicablePhases: Phase.Definition[],
    entries: Array<typeof IntelEntryTable.$inferSelect>,
    sessionID: string,
  ): { canStart: boolean; reason?: string } {
    if (def.prerequisites.length === 0) return { canStart: true }

    const applicableIds = new Set(applicablePhases.map((p) => p.id))
    const missing: string[] = []

    for (const prereq of def.prerequisites) {
      if (!applicableIds.has(prereq)) continue // skip prereqs not in scope
      const prereqDef = Phase.get(prereq)
      if (!prereqDef) continue
      const result = validateDeliverables(prereqDef, entries, sessionID)
      if (!result.completed) missing.push(prereq)
    }

    if (missing.length > 0) return { canStart: false, reason: `Prerequisites incomplete: ${missing.join(", ")}` }
    return { canStart: true }
  }

  function persistPhases(sessionID: string, phases: PhaseState[]) {
    Database.use((db) => {
      for (const phase of phases) {
        const existing = db
          .select()
          .from(MethodologyPhaseTable)
          .where(and(eq(MethodologyPhaseTable.session_id, sessionID), eq(MethodologyPhaseTable.phase_id, phase.id)))
          .get()

        const now = Date.now()
        if (existing) {
          db.update(MethodologyPhaseTable)
            .set({
              status: phase.status,
              completion_evidence: phase.evidence,
              deliverable_count: phase.deliverableCount,
              block_reason: phase.blockReason ?? null,
              started_at: phase.status !== "not_started" && !existing.started_at ? now : existing.started_at,
              completed_at: phase.status === "completed" && !existing.completed_at ? now : existing.completed_at,
            })
            .where(eq(MethodologyPhaseTable.id, existing.id))
            .run()
        } else {
          db.insert(MethodologyPhaseTable)
            .values({
              id: Identifier.ascending("methodology_phase"),
              session_id: sessionID,
              phase_id: phase.id,
              status: phase.status,
              completion_evidence: phase.evidence,
              deliverable_count: phase.deliverableCount,
              block_reason: phase.blockReason ?? null,
              started_at: phase.status !== "not_started" ? now : null,
              completed_at: phase.status === "completed" ? now : null,
              time_created: now,
              time_updated: now,
            })
            .run()
        }
      }
    })
  }

  // --- Violation Generation ---

  function generateViolations(
    sessionID: string,
    entries: Array<typeof IntelEntryTable.$inferSelect>,
    phases: PhaseState[],
    _scopeType: Phase.ScopeType,
  ): ViolationInfo[] {
    const violations: ViolationInfo[] = []

    // 1. methodology_ordering: Check if advanced phases are attempted before basics
    const completedIds = new Set(phases.filter((p) => p.status === "completed").map((p) => p.id))
    for (const phase of phases) {
      if (phase.status === "in_progress" && phase.blockReason) {
        violations.push({
          gate: "methodology_ordering",
          severity: "blocking",
          message: `Phase "${phase.name}" started but ${phase.blockReason}`,
        })
      }
    }

    // 2. methodology_progress: Check if testing is happening without reconnaissance
    const hasRecon =
      completedIds.has("passive_recon") || completedIds.has("active_recon") || completedIds.has("scope_analysis")
    const hasExploitPhase = phases.some(
      (p) => ["input_validation", "authorization_testing", "business_logic"].includes(p.id) && p.deliverableCount > 0,
    )
    if (hasExploitPhase && !hasRecon) {
      violations.push({
        gate: "methodology_progress",
        severity: "warning",
        message: "Exploitation phases active but reconnaissance not completed. Run recon first.",
      })
    }

    // 3. per_asset_coverage: Check coverage uniformity
    const assetCounts = new Map<string, number>()
    for (const entry of entries) {
      const asset = entry.asset.toLowerCase()
      assetCounts.set(asset, (assetCounts.get(asset) || 0) + 1)
    }
    const assets = [...assetCounts.entries()]
    if (assets.length > 1) {
      const avg = entries.length / assets.length
      for (const [asset, count] of assets) {
        if (count < avg * 0.3) {
          violations.push({
            gate: "per_asset_coverage",
            severity: "warning",
            message: `Asset "${asset}" has only ${count} intel entries vs average ${Math.round(avg)}`,
            affectedAsset: asset,
          })
        }
      }
    }

    // 4. evidence_quality: Check for entries marked exploited without PoC
    const exploited = entries.filter((e) => e.status === "exploited")
    for (const entry of exploited) {
      if (!entry.detail || entry.detail.length < 50) {
        violations.push({
          gate: "evidence_quality",
          severity: "blocking",
          message: `Exploited entry "${entry.title}" has insufficient detail (${(entry.detail || "").length} chars, need 50+)`,
          field: "detail",
        })
      }
    }

    // 5. skill_gate: phases with requiredSkills but no matching loaded skill
    for (const phase of phases) {
      const def = Phase.get(phase.id)
      if (!def || !def.requiredSkills || def.requiredSkills.length === 0) continue
      const gate = SkillLoad.satisfied(def, sessionID)
      if (gate.ok) continue
      const active = phase.status !== "not_started" || phase.deliverableCount > 0
      violations.push({
        gate: "skill_gate",
        severity: active && def.minDeliverables > 0 ? "blocking" : "warning",
        message: `Phase "${phase.name}" ${active ? "active" : "pending"} without a loaded methodology skill. Load one matching: ${gate.expected.join(", ")} (skill action=load).`,
      })
    }

    // 6. engagement_missing: active-testing phase activity without an ROE record
    if (!Engagement.get(sessionID)) {
      const active = phases.find((p) => {
        const def = Phase.get(p.id)
        return def?.requiresEngagement && (p.status !== "not_started" || p.deliverableCount > 0)
      })
      if (active) {
        violations.push({
          gate: "engagement_missing",
          severity: "blocking",
          message: `Active testing phase "${active.name}" without a rules-of-engagement record. Run engagement_setup (authorization ref, scope, exclusions, rate limits, test windows, identity types, OOB approval).`,
        })
      }
    }

    // 7. identity_coverage: authorization testing needs ≥2 distinct identities/tenants
    const authzActive = phases.find(
      (p) => p.id === "authorization_testing" && (p.status !== "not_started" || p.deliverableCount > 0),
    )
    if (authzActive) {
      const identities = CoverageNote.identities(sessionID)
      if (identities.length < 2) {
        violations.push({
          gate: "identity_coverage",
          severity: "warning",
          message: `Authorization phase active with ${identities.length} identity/tenant recorded — test at least 2 distinct identities and record them via record_coverage_note (dimension=identity).`,
        })
      }
    }

    // Persist violations
    persistViolations(sessionID, violations)

    return violations
  }

  function persistViolations(sessionID: string, violations: ViolationInfo[]) {
    Database.use((db) => {
      // Clear old unresolved violations for this session
      db.delete(ValidationViolationTable)
        .where(and(eq(ValidationViolationTable.session_id, sessionID), eq(ValidationViolationTable.resolved, 0)))
        .run()

      const now = Date.now()
      for (const v of violations) {
        db.insert(ValidationViolationTable)
          .values({
            id: Identifier.ascending("validation_violation"),
            session_id: sessionID,
            gate: v.gate,
            severity: v.severity,
            message: v.message,
            affected_asset: v.affectedAsset ?? null,
            field: v.field ?? null,
            resolved: 0,
            time_created: now,
            time_updated: now,
          })
          .run()
      }
    })
  }

  // --- Prompt Formatting ---

  export function formatForPrompt(sessionID: string): string {
    const state = computeState(sessionID)
    const lines: string[] = [
      "## Methodology Progress",
      "",
      "| Phase | Status | Deliverables |",
      "|-------|--------|-------------|",
    ]

    for (const phase of state.phases) {
      const icon =
        phase.status === "completed"
          ? "[DONE]"
          : phase.status === "in_progress"
            ? "[ACTIVE]"
            : phase.status === "blocked"
              ? "[BLOCKED]"
              : "[TODO]"
      lines.push(`| ${phase.name} | ${icon} | ${phase.deliverableCount} |`)
    }

    lines.push("")
    lines.push(`Progress: ${state.completionPercent}% (${state.completedCount}/${state.totalCount} phases)`)

    if (state.currentPhase) {
      const current = Phase.get(state.currentPhase)
      if (current) {
        lines.push("")
        lines.push(`### Current Phase: ${current.name}`)
        lines.push(`Required tags: ${current.requiredTags.join(", ")}`)
        lines.push(`Recommended agents: ${current.agents.join(", ")}`)
        if (current.requiredSkills && current.requiredSkills.length > 0) {
          const gate = SkillLoad.satisfied(current, sessionID)
          lines.push(
            gate.ok
              ? `Skill gate: satisfied (loaded: ${gate.matched})`
              : `Skill gate: LOAD REQUIRED — one matching: ${current.requiredSkills.join(", ")}`,
          )
        }
        if (current.requiresEngagement && !Engagement.get(sessionID)) {
          lines.push("Engagement gate: ROE NOT RECORDED — run engagement_setup before active testing")
        }
      }
    }

    const blocking = state.violations.filter((v) => v.severity === "blocking")
    if (blocking.length > 0) {
      lines.push("")
      lines.push("### BLOCKING VIOLATIONS")
      for (const v of blocking) {
        lines.push(`- [${v.gate}] ${v.message}`)
      }
    }

    const warnings = state.violations.filter((v) => v.severity === "warning")
    if (warnings.length > 0) {
      lines.push("")
      lines.push("### Warnings")
      for (const v of warnings) {
        lines.push(`- [${v.gate}] ${v.message}`)
      }
    }

    return lines.join("\n")
  }

  // --- Phase Directives ---

  export function getPhaseDirectives(phaseId: Phase.Id): string {
    const directives: Record<Phase.Id, string> = {
      scope_analysis:
        "Analyze the target scope. Identify all in-scope domains, subdomains, IP ranges. Use add_intel to log each discovered asset with tag 'scope-analysis'.",
      passive_recon:
        "Perform passive reconnaissance: DNS records, WHOIS, certificate transparency, Wayback Machine, Google dorking. Log all subdomains and services via add_intel with tag 'passive-recon'.",
      active_recon:
        "Run active enumeration: port scanning, service detection, directory bruteforcing, crawler. Log live hosts and endpoints via add_intel with tag 'active-recon'.",
      technology_profiling:
        "Identify technology stack: frameworks, CMS, server software, JavaScript libraries. Log each technology via add_intel with tag 'technology'. Check for known CVEs.",
      authentication_testing:
        "Test authentication mechanisms: default credentials, brute force protection, password policy, MFA bypass, account lockout. Log findings with tag 'auth-testing'.",
      session_management:
        "Test session handling: cookie flags, session fixation, session timeout, CSRF protection, token entropy. Log findings with tag 'session-testing'.",
      authorization_testing:
        "Test access controls: IDOR, privilege escalation (horizontal/vertical), missing function-level access control. Build access matrix per role. Log with tag 'authz-testing'.",
      input_validation:
        "Test all input vectors: XSS (reflected/stored/DOM), SQL injection, SSTI, command injection, SSRF, XXE. Use update_vrt_check to record test results per entry.",
      business_logic:
        "Test business logic: race conditions, price manipulation, workflow bypass, feature abuse. Log with tag 'business-logic'.",
      data_protection:
        "Test data protection: sensitive data in URLs, unencrypted storage, missing TLS, improper error handling. Log with tag 'data-protection'.",
      api_security:
        "Test API security: BOLA/IDOR, broken auth, mass assignment, rate limiting, GraphQL introspection. Log with tag 'api-security'.",
      infrastructure:
        "Test infrastructure: cloud misconfigurations, DNS zone transfer, open services, default installations. Log with tag 'infrastructure'.",
      reporting:
        "Call `generate_report` to compile all session data into a structured Markdown report. Review the output, then write three AI sections: Executive Summary (overall risk posture), Risk Assessment (likelihood × impact matrix), and Remediation Priorities (actionable steps). Replace the `<!-- AI: ... -->` placeholders and save to `.bountyreaper/reports/report-<timestamp>.md` via the write tool. Ensure all blocking violations are resolved before finalizing.",
    }
    return directives[phaseId] || ""
  }
}

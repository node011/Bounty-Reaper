import z from "zod"
import { Tool } from "./tool"
import { Methodology } from "../methodology/methodology"
import { Intel } from "../methodology/intel"
import { Chain } from "../methodology/chain"
import { Validation } from "../methodology/validation"
import { Session } from "../session"
import { Engagement } from "../methodology/engagement"
import { SkillLoad } from "../methodology/skill-load"
import { CoverageNote } from "../session/coverage-note"

export const MethodologyStatusTool = Tool.define("methodology_status", {
  description:
    "Get the current methodology state, coverage report, chain opportunities, and validation status. Use this to check progress, identify gaps, and decide what to test next. Shows which phases are complete, which have blocking violations, per-asset coverage, and detected vulnerability chains.",
  parameters: z.object({
    include_validation: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include full validation gate results (evidence quality, triager checks)"),
    scope_items: z
      .array(z.string())
      .optional()
      .describe("Scope items for validation gates (domains, wildcards, CIDRs)"),
  }),
  async execute(params, ctx) {
    const rootSession = Session.root(ctx.sessionID)
    const state = Methodology.computeState(rootSession)
    const coverage = Intel.computeCoverage(rootSession)
    const chains = Chain.load(rootSession)

    const sections: string[] = []

    // 1. Methodology progress
    sections.push(Methodology.formatForPrompt(rootSession))

    // 1b. Engagement (rules of engagement)
    sections.push("")
    sections.push(Engagement.formatForPrompt(rootSession))

    // 1c. Skills loaded (methodology skill-gate evidence)
    const skills = SkillLoad.list(rootSession)
    sections.push("")
    sections.push("## Skills Loaded")
    if (skills.length === 0) {
      sections.push(
        "None — load methodology skills before testing (`skill` action=load). Phases with a skill gate cannot complete without one.",
      )
    } else {
      for (const s of skills) {
        sections.push(`- ${s.skillName} (loaded ${s.loads}x${s.agent ? `, last by ${s.agent}` : ""})`)
      }
    }

    // 1d. Coverage dimensions + identity/tenant coverage
    const dims = CoverageNote.dimensionSummary(rootSession)
    const identities = CoverageNote.identities(rootSession)
    sections.push("")
    sections.push("## Coverage Dimensions")
    if (dims.length === 0) {
      sections.push(
        "None recorded — tag coverage notes with `dimension` (surface/identity/state/input/impact/validation_depth) to track depth, not just counts.",
      )
    } else {
      for (const d of dims) sections.push(`- ${d.dimension}: ${d.count} note(s)`)
    }
    sections.push(
      identities.length >= 2
        ? `- Identities/tenants recorded: ${identities.join(", ")}`
        : `- Identities/tenants recorded: ${identities.length} (authorization testing needs ≥2 distinct identities — record via record_coverage_note dimension=identity)`,
    )

    // 2. Coverage
    sections.push("")
    sections.push(Intel.formatCoverageForPrompt(coverage))

    // 3. Chains
    const chainPrompt = Chain.formatForPrompt(chains)
    if (chainPrompt) {
      sections.push("")
      sections.push(chainPrompt)
    }

    // 4. Validation gates (optional)
    if (params.include_validation) {
      const scopeItems = params.scope_items ?? []
      const gates = Validation.runAllGates(rootSession, scopeItems)
      sections.push("")
      sections.push(gates.summary)
    }

    // 5. Per-asset coverage
    const assetCoverages = Intel.computePerAssetCoverage(rootSession)
    if (assetCoverages.length > 0) {
      sections.push("")
      sections.push("## Per-Asset Coverage")
      for (const ac of assetCoverages) {
        sections.push(
          `- ${ac.asset}: ${ac.coveragePercent}% (${ac.completedChecks}/${ac.totalChecks} checks, ${ac.vulnerableChecks} vuln)`,
        )
      }
    }

    // 6. Next steps
    if (state.currentPhase) {
      const directives = Methodology.getPhaseDirectives(state.currentPhase)
      if (directives) {
        sections.push("")
        sections.push("## Next Steps")
        sections.push(directives)
      }
    }

    return {
      title: `Methodology: ${state.completionPercent}% | Coverage: ${coverage.coveragePercent}%`,
      output: sections.join("\n"),
      metadata: {
        completionPercent: state.completionPercent,
        coveragePercent: coverage.coveragePercent,
        totalEntries: coverage.totalEntries,
        activeChains: chains.filter((c) => c.status === "detected" || c.status === "testing").length,
        blockingViolations: state.violations.filter((v) => v.severity === "blocking").length,
      },
    }
  },
})

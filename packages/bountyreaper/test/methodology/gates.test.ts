import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Methodology } from "../../src/methodology/methodology"
import { MethodologyContext } from "../../src/methodology/context"
import { Flag } from "../../src/flag/flag"
import { Intel } from "../../src/methodology/intel"
import { Engagement } from "../../src/methodology/engagement"
import { SkillLoad } from "../../src/methodology/skill-load"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Audit-driven gates:
//  - engagement gate: active-testing phases require an ROE record
//  - skill gate: phases with requiredSkills need ≥1 matching loaded skill
// Gates default to ADVISORY (hunting never blocks); these tests flip to ENFORCING
// to cover upstream's original semantics, and assert the advisory defaults too.
describe("Methodology — engagement + skill gates", () => {
  test("active_recon needs deliverables → engagement → matching skill, in that order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        process.env.BOUNTYREAPER_METHODOLOGY_GATES = "enforcing"
        try {
        const session = await Session.create({})
        const sid = session.id
        const phase = (id: string) => Methodology.computeState(sid).phases.find((p) => p.id === id)!

        // Recon deliverables for the prerequisite chain + active_recon itself.
        for (const [title, tag] of [
          ["Scope defined", "scope"],
          ["Passive recon done", "passive-recon"],
          ["Live host found", "active-recon"],
        ] as const) {
          Intel.add({
            sessionID: sid,
            data: {
              type: "subdomain",
              severity: "info",
              title,
              detail: `${title} — test fixture for gate validation`,
              asset: "example.com",
              source: "test",
              confidenceLevel: "confirmed",
              tags: [tag],
            },
          })
        }

        // 1. Deliverables present, but no engagement recorded → blocked.
        let ar = phase("active_recon")
        expect(ar.deliverableCount).toBeGreaterThan(0)
        expect(ar.status).not.toBe("completed")
        expect(ar.evidence).toContain("engagement")

        // 2. Engagement recorded → still blocked: no methodology skill loaded.
        Engagement.record({ sessionID: sid, authorizationRef: "TEST-AUTH-001" })
        ar = phase("active_recon")
        expect(ar.status).not.toBe("completed")
        expect(ar.evidence).toContain("no methodology skill loaded")

        // 3. Load a matching skill → gate satisfied, phase completes.
        SkillLoad.record(sid, "recon-methodology", "test")
        ar = phase("active_recon")
        expect(ar.status).toBe("completed")

        // 4. Violations reflect the gates while unmet (fresh session re-check).
        const fresh = await Session.create({})
        Intel.add({
          sessionID: fresh.id,
          data: {
            type: "subdomain",
            severity: "info",
            title: "Live host found",
            detail: "fixture",
            asset: "example.com",
            source: "test",
            confidenceLevel: "confirmed",
            tags: ["active-recon"],
          },
        })
        const violations = Methodology.computeState(fresh.id).violations
        expect(violations.some((v) => v.gate === "engagement_missing" && v.severity === "blocking")).toBe(true)
        expect(violations.some((v) => v.gate === "skill_gate")).toBe(true)

        await Session.remove(session.id)
        await Session.remove(fresh.id)
        } finally {
          delete process.env.BOUNTYREAPER_METHODOLOGY_GATES
        }
      },
    })
  })

  // The default mode: gates surface as advisory evidence, hunting NEVER stops.
  test("advisory (default) — hunting continues with no ROE and no skills", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        expect(Flag.methodologyGates()).toBe("advisory")
        const session = await Session.create({})
        const sid = session.id
        const state = () => Methodology.computeState(sid)
        const phase = (id: string) => state().phases.find((p) => p.id === id)!

        for (const [title, tag] of [
          ["Scope defined", "scope"],
          ["Passive recon done", "passive-recon"],
          ["Live host found", "active-recon"],
        ] as const) {
          Intel.add({
            sessionID: sid,
            data: {
              type: "subdomain",
              severity: "info",
              title,
              detail: "advisory-mode fixture",
              asset: "example.com",
              source: "test",
              confidenceLevel: "confirmed",
              tags: [tag],
            },
          })
        }

        // No engagement, no skill → phase still COMPLETES on deliverables.
        const ar = phase("active_recon")
        expect(ar.deliverableCount).toBeGreaterThan(0)
        expect(ar.status).toBe("completed")
        expect(state().completionPercent).toBeGreaterThan(0)
        // Nothing renders as blocked; gate misses are advisory warnings instead.
        for (const p of state().phases) expect(p.status, p.id).not.toBe("blocked")
        const violations = state().violations
        expect(violations.some((v) => v.gate === "engagement_missing" && v.severity === "warning")).toBe(true)
        // And no self-clearable blocking violation → force-continue stays quiet.
        expect(MethodologyContext.shouldForceContinue(sid).force).toBe(false)

        await Session.remove(session.id)
      },
    })
  })
})

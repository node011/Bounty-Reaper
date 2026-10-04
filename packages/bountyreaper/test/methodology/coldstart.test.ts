import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MethodologyContext } from "../../src/methodology/context"
import { Engagement } from "../../src/methodology/engagement"
import { SkillLoad } from "../../src/methodology/skill-load"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Cold start was the worst friction point: a fresh session showed most phases blocked by
// skill_gate + engagement_missing and the only clue was a pattern list buried in violation
// text. generate() returned null entirely with zero intel, so the agent got NOTHING telling
// it how to proceed. These lock in that the blocker list appears immediately, names the
// exact tool calls, and disappears once cleared.
describe("Cold-start unblocker", () => {
  test("a fresh session is told exactly how to clear the gates", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        const out = MethodologyContext.generate(sid)
        expect(out).not.toBeNull()
        expect(out).toContain("STARTUP BLOCKERS")
        expect(out).toContain("engagement_setup")
        expect(out).toContain('skill(action="load"')
      },
    })
  })

  test("the engagement blocker clears the moment ROE is recorded", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        expect(MethodologyContext.generate(sid)).toContain("engagement_setup")

        Engagement.record({ sessionID: sid, authorizationRef: "https://example.com/policy", oobApproved: true })
        const after = MethodologyContext.generate(sid)!
        expect(after).not.toContain("engagement_setup")
        // Skill gates remain until skills are actually loaded — proving the two
        // blockers are tracked independently rather than cleared by one action.
        expect(after).toContain("STARTUP BLOCKERS")
      },
    })
  })

  test("each skill load retires exactly the phases it satisfies", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        Engagement.record({ sessionID: sid, authorizationRef: "https://example.com/policy" })
        SkillLoad.record(sid, "web2-recon")
        const out = MethodologyContext.generate(sid)!
        // Active Recon is satisfied by a name containing "recon"...
        expect(out).not.toContain("Active Reconnaissance & Enumeration — needs a skill")
        // ...while an unrelated gate is still open.
        expect(out).toContain("Input Validation Testing — needs a skill")
      },
    })
  })

  test("suggest() resolves real catalog skills that satisfy a gate's patterns", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const picks = await SkillLoad.suggest(["recon", "enum", "crawl"])
        expect(picks.length).toBeGreaterThan(0)
        // Whatever it suggests must actually satisfy the gate it was derived from.
        const patterns = ["recon", "enum", "crawl"]
        expect(picks.some((n) => patterns.some((p) => n.toLowerCase().includes(p)))).toBe(true)
      },
    })
  })
})
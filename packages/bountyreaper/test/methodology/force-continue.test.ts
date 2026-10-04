import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MethodologyContext } from "../../src/methodology/context"
import { Engagement } from "../../src/methodology/engagement"
import { SkillLoad } from "../../src/methodology/skill-load"
import { Intel } from "../../src/methodology/intel"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Covers every phase that declares requiredSkills, so skill_gate is satisfied and any
// remaining blocker is isolated to the gate under test.
const ALL_GATE_SKILLS = [
  "web2-recon",
  "attack-jwt-oauth",
  "attack-technology-fingerprint",
  "attack-session-management",
  "attack-access-control",
  "attack-sqli-xss-ssrf",
  "attack-business-logic",
  "attack-data-protection",
  "attack-api-security",
  "attack-infrastructure-testing",
]

// `shouldForceContinue` was written but never called, so a methodology session could end
// the instant the model emitted a text turn. Wiring it naively was NOT safe: it fired on
// ANY blocking violation, including engagement_missing, which the agent cannot clear
// without asking a human — that would burn turns AND suppress the question it must ask.
describe("MethodologyContext.shouldForceContinue", () => {
  test("does NOT force on an unrecorded ROE — the agent must stay free to ask the user", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        Intel.add({ sessionID: sid, data: { type: "endpoint", title: "GET /u", asset: "example.com" } })
        for (const s of ALL_GATE_SKILLS) SkillLoad.record(sid, s)
        expect(Engagement.get(sid)).toBeUndefined()
        expect(MethodologyContext.shouldForceContinue(sid).force).toBe(false)
      },
    })
  })

  test("forces on a self-clearable skill_gate and names the gate in the directive", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        Engagement.record({ sessionID: sid, authorizationRef: "https://example.com/policy", oobApproved: true })
        Intel.add({ sessionID: sid, data: { type: "endpoint", title: "GET /u", asset: "example.com" } })
        // Deliberately load NOTHING → skill_gate is blocking and IS self-clearable.
        const verdict = MethodologyContext.shouldForceContinue(sid)
        expect(verdict.force).toBe(true)
        expect(verdict.directive).toContain("skill_gate")
      },
    })
  })

  test("goes quiet once every gate is genuinely cleared", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        Engagement.record({ sessionID: sid, authorizationRef: "https://example.com/policy", oobApproved: true })
        Intel.add({ sessionID: sid, data: { type: "endpoint", title: "GET /u", asset: "example.com" } })
        for (const s of ALL_GATE_SKILLS) SkillLoad.record(sid, s)
        expect(MethodologyContext.shouldForceContinue(sid).force).toBe(false)
      },
    })
  })

  test("is inert on a session with no methodology intel", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = (await Session.create({})).id
        expect(MethodologyContext.shouldForceContinue(sid)).toEqual({ force: false, directive: "" })
      },
    })
  })
})
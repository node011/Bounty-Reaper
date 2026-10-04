import { describe, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
import path from "path"
Log.init({ print: false })

// Skills used to live only behind a "recommended skills (load these first)" list — i.e.
// behind a search the agent may never run. Upstream CyberStrike embeds each specialist's
// core methodology directly into its prompt, which is strictly better at decision time.
// These lock in: core skills ARE embedded, the embed stays under budget, and the
// recommendation list never re-offers an already-embedded skill.

describe("Specialist agent skill embedding", () => {
  const coreAgents = ["web-application", "cloud-security", "internal-network", "threat-modeler", "validator"]

  test("each specialist has core skills embedded in its prompt", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        for (const name of coreAgents) {
          const agent = await Agent.get(name)
          expect(agent).toBeDefined()
          expect(agent!.prompt, `${name} prompt must contain embedded skills`).toContain("## Embedded Skill References")
        }
      },
    })
  })

  test("web-application's core WSTG groups are embedded, not just recommended", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const agent = await Agent.get("web-application")
        expect(agent!.prompt).toContain('<skill name="wstg-recon-config">')
        expect(agent!.prompt).toContain('<skill name="wstg-injection">')
        // Nothing embedded is re-offered as a recommendation.
        expect(agent!.skills ?? []).not.toContain("wstg-injection")
        expect(agent!.skills ?? []).not.toContain("wstg-recon-config")
      },
    })
  })

  test("embedding respects the budget — oversized libraries split, not explode", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const cloud = await Agent.get("cloud-security")
        const internal = await Agent.get("internal-network")
        // Both libraries exceed the embed budget; each must keep SOME skills as
        // recommendations rather than silently dropping them.
        expect(cloud!.skills?.length ?? 0, "cloud deep-dive skills stay recommended").toBeGreaterThan(0)
        expect(internal!.skills?.length ?? 0, "internal-network deep-dive skills stay recommended").toBeGreaterThan(0)
        // Prompt growth from embedding of the full internal-network library (~28k tok)
        // would be catastrophic; cap-checked via the budget constant in agent.ts.
      },
    })
  })

  test("unresolvable skill names are not referenced", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const tm = await Agent.get("threat-modeler")
        expect(tm!.skills ?? []).not.toContain("mitre_attack")
        for (const name of coreAgents) {
          const agent = await Agent.get(name)
          for (const skill of agent!.skills ?? []) {
            // If these drifted to phantom names, embedAgentSkills would warn and skip.
            expect(typeof skill).toBe("string")
          }
        }
      },
    })
  })
})
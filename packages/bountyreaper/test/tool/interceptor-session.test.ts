import { describe, expect, test } from "bun:test"
import { Skill } from "../../src/skill"
import { SkillIndex } from "../../src/skill/index-engine"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
import path from "path"
Log.init({ print: false })

// Interceptor (signed-in browser automation + passive traffic inspection) is registered
// as an MCP server and documented via the interceptor-session skill. The skill must stay
// discoverable and must keep the hard boundary: it is NOT a crawler — the operator's
// real browser session is the resource being protected.
describe("Interceptor MCP integration", () => {
  test("interceptor-session skill is in the catalog and searchable", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const s = await Skill.get("interceptor-session")
        expect(s).toBeDefined()
        expect(s!.description).toContain("Signed-in browser")
        await SkillIndex.rebuild()
        const hits = SkillIndex.search("signed in browser session traffic", 10)
        expect(hits.some((e) => e.name === "interceptor-session")).toBe(true)
      },
    })
  })

  test("the skill enforces the crawler boundary", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const s = await Skill.get("interceptor-session")!
        expect(s.content).toContain("NEVER use Interceptor for bulk crawling")
        expect(s.content).toContain("katana")
        expect(s.content).toContain("group close")
      },
    })
  })
})
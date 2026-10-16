import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

process.env.BOUNTYREAPER_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hs-sync-"))
const { Hindsight } = await import("../../src/hindsight")
const { HindsightSkillSync } = await import("../../src/hindsight/skill-sync")

// Auto-skill update (omp learn → managed skill, Hermes-style refresh): lessons from
// the project bank compile into a per-project SKILL.md under the USER-level store,
// outside the repo — so session artifacts never ship in git. Offline tests pin the
// no-crash/no-file-invariants; the live path was verified against the local container.

describe("HindsightSkillSync offline-honesty", () => {
  test("refresh is inert (no crash, no file) while the backend is down", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    const dir = await HindsightSkillSync.refresh()
    expect(dir).toBeUndefined()
    expect(fs.existsSync(path.join(HindsightSkillSync.skillDir(), "SKILL.md"))).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })
})

describe("HindsightSkillSync.renderLessons", () => {
  test("emits loadable skill frontmatter + per-lesson bullets", () => {
    const out = HindsightSkillSync.renderLessons("bountyreaper-global", [
      "Distinct marker per parallel lane keeps OOB callbacks attributable.",
      "- already-bulleted lesson survives",
      "   spaced lines collapse",
    ])
    expect(out).toContain("name: lessons-bountyreaper-global")
    expect(out).toContain("## Lessons (3)")
    expect(out).toContain("- Distinct marker per parallel lane")
    expect(out).toContain("- already-bulleted lesson survives")
    expect(out).toContain("- spaced lines collapse")
    expect(out).toContain("Auto-managed: regenerated from Hindsight")
  })

  test("gracefully renders empty lesson sources as empty list (caller decides not to write)", () => {
    const out = HindsightSkillSync.renderLessons("x", [])
    expect(out).toContain("## Lessons (0)")
  })
})
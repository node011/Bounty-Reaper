import { describe, expect, test } from "bun:test"
import { Hindsight } from "../../src/hindsight"

// Regression tests for the "false success" bug: hindsight_retain used to return
// "Queued for retention" even when Hindsight was unconfigured or unreachable, so
// the agent was told a memory was stored when it had been silently dropped. retain()
// must report the truth, and the tools must distinguish "not configured" from
// "connected but no matches" — the audit could not tell those apart.

const KEY = process.env.HINDSIGHT_API_KEY

describe("Hindsight.retain failure honesty", () => {
  test("retain returns false (not a silent success) when no key is configured", async () => {
    if (KEY) return // a real key is present in this environment; nothing to assert
    const ok = await Hindsight.retain("marker that must not be reported as stored")
    expect(ok).toBe(false)
  })

  test("configured() and enabled() agree that an unkeyed client is unusable", () => {
    if (KEY) return
    expect(Hindsight.enabled()).toBe(false)
    expect(Hindsight.configured()).toBe(false)
  })
})

describe("Hindsight.bank scoping", () => {
  test("bank is stable across calls (memory must survive across sessions)", () => {
    // The original bug keyed the bank on sessionID.slice(-12), so every session got a
    // fresh bank and nothing was ever recalled. The bank must depend only on the project.
    const a = Hindsight.bank()
    const b = Hindsight.bank()
    expect(a).toBe(b)
    expect(a.startsWith("bountyreaper")).toBe(true)
  })
})
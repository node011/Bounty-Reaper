import { describe, expect, test } from "bun:test"
import { Hindsight } from "../../src/hindsight"

// Regression tests for the "false success" bug: hindsight_retain used to return
// "Queued for retention" even when Hindsight was unconfigured or unreachable, so
// the agent was told a memory was stored when it had been silently dropped. retain()
// must report the truth, and the tools must distinguish "not configured" from
// "connected but no matches".

// Local-first default: no env var and no stored key => the module targets the shipped
// local Docker endpoint (http://localhost:8888) and needs NO key. When that container
// is absent, the startup probe marks the session unhealthy and every operation fails
// HONESTLY (never a fake success).

describe("Hindsight local-first fail-honesty", () => {
  test("retain reports failure honestly when the endpoint is unreachable", async () => {
    // Deterministic offline fixture: dead port wins over whatever is actually running
    // (a live local container on the dev machine must not make this test flaky).
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    expect(Hindsight.enabled()).toBe(true) // local mode is enabled by default
    expect(Hindsight.configured()).toBe(false) // ...but unusable while the endpoint is down
    const ok = await Hindsight.retain("marker that must not be reported as stored")
    expect(ok).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("cloud mode without a key stays disabled", async () => {
    if (process.env.HINDSIGHT_API_KEY) return
    process.env.HINDSIGHT_BASE_URL = "https://api.hindsight.vectorize.io"
    await Hindsight.init()
    expect(Hindsight.enabled()).toBe(false)
    expect(Hindsight.configured()).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })
})

describe("Hindsight.bank scoping", () => {
  test("bank is stable across calls (memory must survive across sessions)", () => {
    // The original bug keyed the bank on sessionID.slice(-12), so every session got a
    // fresh bank and nothing was ever recalled. The bank depends only on the project.
    const a = Hindsight.bank()
    const b = Hindsight.bank()
    expect(a).toBe(b)
    expect(a.startsWith("bountyreaper")).toBe(true)
  })
})

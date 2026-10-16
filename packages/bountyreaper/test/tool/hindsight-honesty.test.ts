import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

// Set an ISOLATED config home BEFORE importing the module under test — auth.json and
// the global data dir are resolved at module import time. Without this the tests
// would read the operator's real stored cloud key and become machine-dependent.
process.env.BOUNTYREAPER_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hindsight-test-"))

const { Hindsight } = await import("../../src/hindsight")

// Regression tests for the "false success" bug: hindsight_retain used to report
// "Queued for retention" even when Hindsight was unconfigured or unreachable, so the
// agent was told a memory was stored when it had been silently dropped. retain() must
// report the truth, and the tools must distinguish "not configured" from "connected
// but no matches".

// LOCAL IS THE DEFAULT MEMORY: no env vars => the shipped local Docker endpoint, no
// key required. A stored cloud key must NEVER flip the endpoint back to cloud (that
// legacy precedence re-routed a migrated operator straight to the vendor).

describe("Hindsight local-first semantics", () => {
  test("default endpoint is local even when a key is present (key never flips to cloud)", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_API_KEY = "hsk_test_key_abcdefghijklmnopqrstuvwxyz"
    await Hindsight.init()
    expect(Hindsight.baseUrl()).toBe(Hindsight.LOCAL_URL)
    expect(Hindsight.enabled()).toBe(true)
    delete process.env.HINDSIGHT_API_KEY
  })

  test("retain reports failure honestly when the endpoint is unreachable", async () => {
    Hindsight.resetForTests()
    // Dead port keeps this deterministic regardless of a live container on the box.
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    expect(Hindsight.enabled()).toBe(true) // loopback counts as local
    expect(Hindsight.configured()).toBe(false) // ...but unusable while the endpoint is down
    const ok = await Hindsight.retain("marker that must not be reported as stored")
    expect(ok).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("explicit cloud endpoint without a key stays disabled", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "https://api.hindsight.vectorize.io"
    await Hindsight.init()
    expect(Hindsight.enabled()).toBe(false)
    expect(Hindsight.configured()).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("bank is stable across calls (memory must survive across sessions)", () => {
    const a = Hindsight.bank()
    const b = Hindsight.bank()
    expect(a).toBe(b)
    expect(a.startsWith("bountyreaper")).toBe(true)
  })
})

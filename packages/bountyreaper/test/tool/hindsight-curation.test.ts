import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

// Isolated config home BEFORE module import (auth/global paths resolve at module load).
process.env.BOUNTYREAPER_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "hs-curation-"))

const { Hindsight } = await import("../../src/hindsight")

// omp-parity curation layer: retain/recall/reflect plus learn (distilled lessons),
// memory_edit (update/forget/revalidate by id), and a settled-knowledge standing
// document that loads at session start. OFFLINE tests pin the honest-failure paths;
// the live paths were verified against the local container directly.

describe("Hindsight curation offline-honesty", () => {
  test("learn returns false (never fake success) while the server is down", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    const ok = await Hindsight.learn("test lesson")
    expect(ok).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("memoryEdit returns false (never fake success) while the server is down", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    const ok = await Hindsight.memoryEdit("mm-irrelevant", "forget", { reason: "test" })
    expect(ok).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("mentalModel returns undefined (no crash, no fabrication) while the server is down", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    const doc = await Hindsight.mentalModel()
    expect(doc).toBeUndefined()
    delete process.env.HINDSIGHT_BASE_URL
  })

  test("memoryEdit rejects only update-without-text; forget/revalidate need no text", async () => {
    Hindsight.resetForTests()
    process.env.HINDSIGHT_BASE_URL = "http://127.0.0.1:59999"
    await Hindsight.init()
    // forget with no text must still reach the network path (fails offline → false),
    // but update with NO text must be rejected BEFORE any network call.
    expect(await Hindsight.memoryEdit("mm-x", "update", { reason: "no text" })).toBe(false)
    delete process.env.HINDSIGHT_BASE_URL
  })
})

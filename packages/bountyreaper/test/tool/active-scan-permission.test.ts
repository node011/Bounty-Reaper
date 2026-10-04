import { describe, expect, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"

// The active-scan gate must resolve through the SAME permission machinery as every
// other tool, so automated testing stays automated: an allow rule in config (or
// skipPermissions' {"*":"allow"}) approves without waiting for a human, and only a
// genuinely unmatched pattern waits for one.
describe("active_scan permission resolution", () => {
  test("allow rule auto-approves without waiting", () => {
    const rule = PermissionNext.evaluate("active_scan", "nmap *", [{ permission: "active_scan", pattern: "*", action: "allow" }])
    expect(rule.action).toBe("allow")
  })

  test("skipPermissions-style wildcard allow auto-approves", () => {
    const rule = PermissionNext.evaluate("active_scan", "nmap *", [{ permission: "*", pattern: "*", action: "allow" }])
    expect(rule.action).toBe("allow")
  })

  test("deny rule halts with DeniedError, never a hang", () => {
    const ruleset: PermissionNext.Rule[] = [{ permission: "active_scan", pattern: "*", action: "deny" }]
    expect(() => {
      const rule = PermissionNext.evaluate("active_scan", "nmap *", ruleset)
      if (rule.action === "deny") throw new PermissionNext.DeniedError(ruleset)
    }).toThrow(PermissionNext.DeniedError)
  })

  test("no matching rule asks (human decision)", () => {
    const rule = PermissionNext.evaluate("active_scan", "nmap *", [])
    expect(rule.action).toBe("ask")
  })
})
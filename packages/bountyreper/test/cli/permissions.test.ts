import { test, expect, afterEach } from "bun:test"
import { Flag } from "../../src/flag/flag"

const saved = process.env.BOUNTYREPER_PERMISSION

afterEach(() => {
  if (saved === undefined) delete process.env.BOUNTYREPER_PERMISSION
  else process.env.BOUNTYREPER_PERMISSION = saved
})

test("skipPermissions sets wildcard allow", () => {
  delete process.env.BOUNTYREPER_PERMISSION
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREPER_PERMISSION!)).toEqual({ "*": "allow" })
})

test("skipPermissions preserves existing rules and wins on merge order", () => {
  process.env.BOUNTYREPER_PERMISSION = JSON.stringify({ bash: "deny", edit: "allow" })
  Flag.skipPermissions()
  const parsed = JSON.parse(process.env.BOUNTYREPER_PERMISSION!) as Record<string, string>
  expect(parsed).toEqual({ bash: "deny", edit: "allow", "*": "allow" })
  expect(Object.keys(parsed).at(-1)).toBe("*")
})

test("skipPermissions recovers from invalid or non-object env", () => {
  process.env.BOUNTYREPER_PERMISSION = "not-json{"
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREPER_PERMISSION!)).toEqual({ "*": "allow" })

  process.env.BOUNTYREPER_PERMISSION = '["allow"]'
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREPER_PERMISSION!)).toEqual({ "*": "allow" })
})

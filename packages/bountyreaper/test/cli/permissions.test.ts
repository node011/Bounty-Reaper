import { test, expect, afterEach } from "bun:test"
import { Flag } from "../../src/flag/flag"

const saved = process.env.BOUNTYREAPER_PERMISSION

afterEach(() => {
  if (saved === undefined) delete process.env.BOUNTYREAPER_PERMISSION
  else process.env.BOUNTYREAPER_PERMISSION = saved
})

test("skipPermissions sets wildcard allow", () => {
  delete process.env.BOUNTYREAPER_PERMISSION
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREAPER_PERMISSION!)).toEqual({ "*": "allow" })
})

test("skipPermissions preserves existing rules and wins on merge order", () => {
  process.env.BOUNTYREAPER_PERMISSION = JSON.stringify({ bash: "deny", edit: "allow" })
  Flag.skipPermissions()
  const parsed = JSON.parse(process.env.BOUNTYREAPER_PERMISSION!) as Record<string, string>
  expect(parsed).toEqual({ bash: "deny", edit: "allow", "*": "allow" })
  expect(Object.keys(parsed).at(-1)).toBe("*")
})

test("skipPermissions recovers from invalid or non-object env", () => {
  process.env.BOUNTYREAPER_PERMISSION = "not-json{"
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREAPER_PERMISSION!)).toEqual({ "*": "allow" })

  process.env.BOUNTYREAPER_PERMISSION = '["allow"]'
  Flag.skipPermissions()
  expect(JSON.parse(process.env.BOUNTYREAPER_PERMISSION!)).toEqual({ "*": "allow" })
})

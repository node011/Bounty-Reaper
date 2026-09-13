import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { PermissionNext } from "../../src/permission/next"
import type { MessageV2 } from "../../src/session/message-v2"

const seed = { permission: "task", pattern: "*", action: "deny" } as const
const todo = { permission: "todowrite", pattern: "*", action: "deny" } as const

function delegating() {
  return { permission: PermissionNext.fromConfig({ "*": "deny", task: "allow" }) }
}

function leaf() {
  return { permission: PermissionNext.fromConfig({ "*": "deny", bash: "allow" }) }
}

describe("session.prompt.repairSeed", () => {
  test("root sessions are never stripped (the seed only exists on task-created subagents)", () => {
    expect(SessionPrompt.repairSeed({ permission: [seed] }, delegating())).toBeUndefined()
  })

  test("strips the seeded deny once the running agent allows task, keeping other rules", () => {
    expect(SessionPrompt.repairSeed({ parentID: "p", permission: [todo, seed] }, delegating())).toStrictEqual([todo])
  })

  test("keeps the seed when the running agent still denies task", () => {
    expect(SessionPrompt.repairSeed({ parentID: "p", permission: [todo, seed] }, leaf())).toBeUndefined()
  })

  test("no seeded deny → nothing to strip", () => {
    expect(SessionPrompt.repairSeed({ parentID: "p", permission: [todo] }, delegating())).toBeUndefined()
    expect(SessionPrompt.repairSeed({ parentID: "p" }, delegating())).toBeUndefined()
  })
})

function msg(agent: string, role: "user" | "assistant" = "user") {
  return { info: { role, agent }, parts: [] } as unknown as MessageV2.WithParts
}

describe("session.prompt.fallback", () => {
  test("picks the most recent user message naming a registered agent", () => {
    const msgs = [msg("general"), msg("proxy-agent")]
    expect(SessionPrompt.fallback(msgs, ["general", "proxy-agent"])).toBe("proxy-agent")
  })

  test("walks past unregistered names (e.g. synthetic hackbrowser notes)", () => {
    const msgs = [msg("general"), msg("hackbrowser")]
    expect(SessionPrompt.fallback(msgs, ["general"])).toBe("general")
  })

  test("ignores assistant messages", () => {
    const msgs = [msg("proxy-agent", "assistant"), msg("hackbrowser")]
    expect(SessionPrompt.fallback(msgs, ["general", "proxy-agent"])).toBeUndefined()
  })

  test("returns undefined when no user message names a registered agent", () => {
    expect(SessionPrompt.fallback([msg("hackbrowser")], ["general"])).toBeUndefined()
  })
})

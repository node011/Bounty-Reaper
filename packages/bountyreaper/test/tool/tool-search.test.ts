import { describe, expect, test } from "bun:test"
import type { Tool } from "../../src/tool/tool"
import { ToolSearchTool } from "../../src/tool/tool-search"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "test",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

describe("tool.tool_search", () => {
  test("description states MCP-only scope", async () => {
    const tool = await ToolSearchTool.init()
    expect(tool.description).toContain("MCP")
    expect(tool.description).toContain("already callable directly")
  })

  test("empty result guides the model away from searching for built-ins", async () => {
    const tool = await ToolSearchTool.init()
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async () => {},
    }
    const result = await tool.execute({ query: "hackbrowser browser automation crawling", limit: 5 }, ctx)
    expect(result.output).toContain("No matching MCP server tools found")
    expect(result.output).toContain("Built-in tools")
    expect(result.output).toContain("already callable directly")
  })
})

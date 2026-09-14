import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { PackageRegistry } from "../../src/bun/registry"

// Installing a custom tool's external deps requires @bountyreaper-io/plugin to be
// resolvable from the npm registry — Config.installDependencies() deliberately
// bails out when it is not, rather than attempting an install that cannot work.
// Until the package is published, that precondition is unmet on a fresh clone,
// so the test below reports "skipped for a known reason" instead of failing.
const pluginPublished = await PackageRegistry.available("@bountyreaper-io/plugin")

describe("tool.registry", () => {
  test("loads tools from .bountyreaper/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bountyreaperDir = path.join(dir, ".bountyreaper")
        await fs.mkdir(bountyreaperDir, { recursive: true })

        const toolDir = path.join(bountyreaperDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test("loads tools from .bountyreaper/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bountyreaperDir = path.join(dir, ".bountyreaper")
        await fs.mkdir(bountyreaperDir, { recursive: true })

        const toolsDir = path.join(bountyreaperDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
    })
  })

  test.skipIf(!pluginPublished)("loads tools with external dependencies without crashing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const bountyreaperDir = path.join(dir, ".bountyreaper")
        await fs.mkdir(bountyreaperDir, { recursive: true })

        const toolsDir = path.join(bountyreaperDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(bountyreaperDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@bountyreaper-io/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        )

        await Bun.write(
          path.join(toolsDir, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Registry should not crash when a tool has external deps.
        // waitForDependencies() installs the deps, then the tool loads normally.
        const ids = await ToolRegistry.ids()
        expect(Array.isArray(ids)).toBe(true)
        expect(ids).toContain("cowsay")
      },
    })
  })
})

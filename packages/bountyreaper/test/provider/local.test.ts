import { test, expect } from "bun:test"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { addProvider, locateProvider, removeModel, removeProvider } from "../../src/provider/local"
import { Auth } from "../../src/auth"

test("project scope: add, locate, remove model, remove provider", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { providerID, modelCount } = await addProvider({
        name: "Local Llama",
        baseURL: "http://127.0.0.1:8000/v1/",
        models: [{ id: "m1" }, { id: "m2", owned_by: "test" }],
        scope: "project",
      })
      expect(providerID).toBe("local-llama")
      expect(modelCount).toBe(2)

      const filepath = path.join(tmp.path, "bountyreaper.json")
      const written = await Bun.file(filepath).json()
      expect(written.provider["local-llama"].api).toBe("http://127.0.0.1:8000/v1")
      expect(Object.keys(written.provider["local-llama"].models)).toEqual(["m1", "m2"])

      const found = await locateProvider("local-llama")
      expect(found?.scope).toBe("project")
      expect(found?.filepath).toBe(filepath)
      expect(found?.models).toEqual(["m1", "m2"])

      const dropped = await removeModel(found!, "local-llama", "m1")
      expect(dropped).toBe(false)
      const after = await Bun.file(filepath).json()
      expect(Object.keys(after.provider["local-llama"].models)).toEqual(["m2"])

      await removeProvider((await locateProvider("local-llama"))!, "local-llama")
      expect(await locateProvider("local-llama")).toBeUndefined()
      const gone = await Bun.file(filepath).json()
      expect(gone.provider["local-llama"]).toBeUndefined()
    },
  })
})

test("global scope: add with api key, remove deletes provider and credentials", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { providerID } = await addProvider({
        name: "Remote Box",
        baseURL: "http://192.168.1.201:8000/v1",
        apiKey: "sk-test-key",
        models: [{ id: "m1" }],
        scope: "global",
      })
      expect(providerID).toBe("remote-box")

      expect(await Auth.get("remote-box")).toBeDefined()

      const found = await locateProvider("remote-box")
      expect(found?.scope).toBe("global")
      expect(found?.models).toEqual(["m1"])

      await removeProvider(found!, "remote-box")

      expect(await locateProvider("remote-box")).toBeUndefined()
      expect(await Auth.get("remote-box")).toBeUndefined()
    },
  })
})

test("removing last model removes the whole provider", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await addProvider({
        name: "Solo",
        baseURL: "http://127.0.0.1:9000/v1",
        models: [{ id: "only" }],
        scope: "project",
      })

      const found = await locateProvider("solo")
      expect(found?.models).toEqual(["only"])

      const dropped = await removeModel(found!, "solo", "only")
      expect(dropped).toBe(true)
      expect(await locateProvider("solo")).toBeUndefined()
    },
  })
})

test("locate prefers project over global, honors scope filter", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await addProvider({
        name: "Dup",
        baseURL: "http://127.0.0.1:8000/v1",
        models: [{ id: "m1" }],
        scope: "global",
      })

      expect((await locateProvider("dup"))?.scope).toBe("global")
      expect(await locateProvider("dup", "project")).toBeUndefined()

      await addProvider({
        name: "Dup",
        baseURL: "http://127.0.0.1:8000/v1",
        models: [{ id: "m1" }],
        scope: "project",
      })

      expect((await locateProvider("dup"))?.scope).toBe("project")
      expect((await locateProvider("dup", "global"))?.scope).toBe("global")

      await removeProvider((await locateProvider("dup", "global"))!, "dup")
      await removeProvider((await locateProvider("dup"))!, "dup")
    },
  })
})

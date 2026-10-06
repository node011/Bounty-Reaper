import { describe, expect, test } from "bun:test"
import { Skill } from "../src/skill"
import { SkillIndex } from "../src/skill/index-engine"
import { Instance } from "../src/project/instance"
import { Log } from "../src/util/log"
import path from "path"
const root = path.join(__dirname, "..")
Log.init({ print: false })

describe("SSRF sub-skills (blind-harvest, k8s-mesh)", () => {
  test("both resolve from the catalog and the router points at them", async () => {
    await Instance.provide({ directory: root, fn: async () => {
      for (const n of ["attack-ssrf-blind-harvest", "attack-ssrf-k8s-mesh"]) {
        const s = await Skill.get(n)
        expect(s, `${n} must resolve`).toBeDefined()
      }
      const router = await Skill.get("attack-ssrf")!
      expect(router.content).toContain("attack-ssrf-blind-harvest")
      expect(router.content).toContain("attack-ssrf-k8s-mesh")
      expect(router.content).toContain("9901")
      expect(router.content).toContain("10250")
    }})
  })

  test("intent queries route to the right sub-skill", async () => {
    await Instance.provide({ directory: root, fn: async () => {
      await SkillIndex.rebuild()
      const harvest = SkillIndex.search("blind ssrf metadata config exfil dns", 5).map(e => e.name)
      expect(harvest).toContain("attack-ssrf-blind-harvest")
      const k8s = SkillIndex.search("kubelet port scan configmap envoy 9901", 5).map(e => e.name)
      expect(k8s).toContain("attack-ssrf-k8s-mesh")
    }})
  })

  test("critical-activity content present (config dump, secret dump)", async () => {
    await Instance.provide({ directory: root, fn: async () => {
      const k8s = await Skill.get("attack-ssrf-k8s-mesh")!
      for (const frag of ["config_dump", "10255", "etcd", "configmaps", "secrets"])
        expect(k8s.content, `k8s-mesh must mention ${frag}`).toContain(frag)
      const harvest = await Skill.get("attack-ssrf-blind-harvest")!
      for (const frag of ["actuator", "169.254.169.254", "DNS", "REDACT"])
        expect(harvest.content, `blind-harvest must mention ${frag}`).toContain(frag)
      expect(harvest.content).toContain("Evidence bar")
    }})
  })
})

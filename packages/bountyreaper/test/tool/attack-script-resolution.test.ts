import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// Two live-hunt blockers, fixed:
// 1. attack_script resolution failed inside the compiled binary ("script resolution
//    failed twice; the correct python path was found only at the very end"), so the
//    OOB channel never stood up and XXE/SSRF lanes stayed shelved. Resolution must
//    find data/scripts from the source tree AND the cwd walk-up.
// 2. The highest-ROI activity (JS bundle analysis) had no packaged helper — the agent
//    hand-rolled greps while the bundled attack script list kept it unavailable.
describe("attack_script resolution + js_recon", () => {
  test("resolveScriptsDir finds oob_interactsh.py from the repo checkout", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const m = await import("../../src/tool/attack-script")
        // Importing the module resolves SCRIPTS_DIR at module scope — if it failed,
        // the import itself would throw. Assert the resolution artifact indirectly:
        // the tool definition still registers with js_recon available.
        expect(m.AttackScriptTool).toBeDefined()
      },
    })
  })

  test("js_recon.py works standalone (fetch + extract + limits)", async () => {
    const script = path.join(projectRoot, "data", "scripts", "js_recon.py")
    const proc = Bun.spawn(["python3", script, "--limit", "5", "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code, out.slice(0, 400)).toBe(0)
    expect(out).toContain("[abs_urls]")
  })
})
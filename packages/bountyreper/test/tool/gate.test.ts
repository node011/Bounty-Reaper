import { describe, expect, test } from "bun:test"
import { Gate } from "../../src/tool/gate"

// Only these two categories skip the permission prompt. If a dangerous program
// ever classifies into one of them, it runs with no operator consent — so the
// direction that matters in these tests is "must NOT be silent".
const SILENT: Gate.Category[] = ["recon", "audit"]
const silent = (c: Gate.Category) => SILENT.includes(c)

describe("Gate.fromName", () => {
  test("credential harvesting is never silent", () => {
    for (const p of [
      "shadow_dump",
      "ssh_key_harvest",
      "browser_creds",
      "gnome_keyring_dump",
      "dump_lsass",
      "kerberos_ticket_export",
      "cloud_cred_harvest",
      "list_passwords",
      "show_secrets",
      "enum_credentials",
    ]) {
      expect(silent(Gate.fromName(p))).toBe(false)
    }
  })

  test("dangerous verbs win over read-only ones", () => {
    // "list"/"show"/"enum" would classify as recon on their own; the credential
    // signal has to take precedence or these auto-approve.
    expect(Gate.fromName("list_passwords")).toBe("credential")
    expect(Gate.fromName("show_secrets")).toBe("credential")
    expect(Gate.fromName("enum_credentials")).toBe("credential")
  })

  test("categories map as expected", () => {
    expect(Gate.fromName("shadow_dump")).toBe("credential")
    expect(Gate.fromName("cron_persist")).toBe("persistence")
    expect(Gate.fromName("dns_tunnel_exfil")).toBe("exfil")
    expect(Gate.fromName("ssh_pivot_lateral")).toBe("lateral")
    expect(Gate.fromName("history_clear")).toBe("evasion")
    expect(Gate.fromName("timestomp")).toBe("evasion")
    expect(Gate.fromName("suid_check")).toBe("privesc")
    expect(Gate.fromName("arp_spoof")).toBe("network")
    expect(Gate.fromName("system_info")).toBe("recon")
    expect(Gate.fromName("detect_env")).toBe("recon")
  })

  test("unrecognised programs are not silent", () => {
    // Deny-by-default: an unclassified program prompts rather than running free.
    expect(silent(Gate.fromName("some_new_program"))).toBe(false)
    expect(Gate.fromName("some_new_program")).toBe("unknown")
  })
})

describe("Gate.fromModule", () => {
  test("hook package layout maps to categories", () => {
    expect(Gate.fromModule("recon")).toBe("recon")
    expect(Gate.fromModule("credential")).toBe("credential")
    expect(Gate.fromModule("kerberos")).toBe("credential")
    expect(Gate.fromModule("privesc")).toBe("privesc")
    expect(Gate.fromModule("ad-exploit")).toBe("privesc")
    expect(Gate.fromModule("injection")).toBe("privesc")
    expect(Gate.fromModule("persistence")).toBe("persistence")
    expect(Gate.fromModule("lateral")).toBe("lateral")
    expect(Gate.fromModule("evasion")).toBe("evasion")
    expect(Gate.fromModule("cleanup")).toBe("evasion")
    expect(Gate.fromModule("exfil")).toBe("exfil")
    expect(Gate.fromModule("network")).toBe("network")
  })

  test("no dangerous module is silent", () => {
    for (const m of [
      "credential",
      "privesc",
      "persistence",
      "lateral",
      "evasion",
      "exfil",
      "network",
      "kerberos",
      "injection",
      "ad-exploit",
      "cleanup",
      "impact",
      "m365",
    ]) {
      expect(silent(Gate.fromModule(m))).toBe(false)
    }
  })
})

describe("Gate.classify", () => {
  test("module wins when it is decisive", () => {
    // The handler lives in credential.ts, so it is credential even though the
    // bare name would read as recon.
    expect(Gate.classify("list_things", "credential")).toBe("credential")
  })

  test("falls back to the name when the module is unrecognised", () => {
    expect(Gate.classify("shadow_dump", "misc")).toBe("credential")
    expect(Gate.classify("system_info", "misc")).toBe("recon")
  })

  test("falls back to the name when no module is given", () => {
    expect(Gate.classify("cron_persist")).toBe("persistence")
  })
})

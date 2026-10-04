import { describe, expect, test } from "bun:test"
import path from "path"
import { Gate } from "../../src/tool/gate"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

// The audit's central failure: `engagement_missing` was flagged on every active-testing
// phase but nothing consulted it, so `bash nmap 10.0.0.1` ran with no rules of
// engagement on record. These lock the DETECTION half of the fix — it must catch real
// invocations without firing on ordinary commands, because a gate that trips on `ls`
// gets disabled wholesale and then protects nothing.
describe("Gate.isActiveScan", () => {
  const blocked = [
    "nmap -sV 10.0.0.1",
    "sudo nmap -p- 192.168.1.1",
    "masscan 10.0.0.0/8",
    "naabu -host 10.0.0.1",
    "nikto -h https://example.com",
    "cd /tmp && nmap scanme.nmap.org",
    "nmap -sV 10.0.0.1 && echo done",
    "hping3 -S 10.0.0.1",
    "arp-scan --localnet",
  ]

  test.each(blocked)("blocks active scan: %s", (cmd) => {
    expect(Gate.isActiveScan(cmd)).toBe(true)
  })

  const allowed = [
    // loopback is local testing, not a target
    "nmap -sV 127.0.0.1",
    "nmap localhost",
    "curl http://localhost:3000",
    // passive recon sends nothing to the target
    "subfinder -d example.com -silent",
    "amass enum -passive -d example.com",
    "whois example.com",
    "curl -s https://crt.sh/?q=example.com",
    // must not match the scanner as a SUBSTRING
    "grep -r nmap ~/notes.txt",
    'echo "run nmap against the target"',
    "cat nmap-cheatsheet.md",
    // ordinary work
    "ls -la",
    "git status",
    "bun test",
  ]

  test.each(allowed)("allows: %s", (cmd) => {
    expect(Gate.isActiveScan(cmd)).toBe(false)
  })
})
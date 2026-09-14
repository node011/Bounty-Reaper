import z from "zod"

export const Runbook = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  agents: z.array(z.string()),
  phases: z.array(z.string()),
  scope: z.string(),
  opsec: z.enum(["strict", "moderate", "permissive"]),
  autonomy: z.enum(["manual", "assisted", "autonomous"]),
})

export type Runbook = z.infer<typeof Runbook>

export const RUNBOOKS: Runbook[] = [
  {
    id: "appsec-web-triage",
    name: "AppSec Web Triage",
    description: "Triage web app for OWASP Top 10, track findings to reportable",
    agents: ["web-application", "proxy-agent"],
    phases: ["scope_analysis", "active_recon", "input_validation", "authorization_testing"],
    scope: "web",
    opsec: "moderate",
    autonomy: "assisted",
  },
  {
    id: "web-surface",
    name: "Web Surface Mapping",
    description: "Map attack surface, enumerate endpoints, build context",
    agents: ["web-application", "explore"],
    phases: ["scope_analysis", "passive_recon", "active_recon", "technology_profiling"],
    scope: "web",
    opsec: "strict",
    autonomy: "assisted",
  },
  {
    id: "pwn",
    name: "Pwn — Scoped Pentest",
    description: "Full pentest workflow with proxy interception and parallel testers",
    agents: ["bountyreaper", "proxy-agent"],
    phases: ["scope_analysis", "active_recon", "authentication_testing", "authorization_testing", "input_validation", "business_logic"],
    scope: "web",
    opsec: "permissive",
    autonomy: "autonomous",
  },
]

export function getRunbook(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id)
}

export function listRunbooks(): Runbook[] {
  return RUNBOOKS
}

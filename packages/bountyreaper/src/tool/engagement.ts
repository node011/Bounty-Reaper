import z from "zod"
import { Tool } from "./tool"
import { Engagement } from "../methodology/engagement"
import { Session } from "../session"

export const EngagementSetupTool = Tool.define("engagement_setup", {
  description:
    "Record (or update) the rules of engagement for this session BEFORE active testing. " +
    "Active-testing methodology phases are blocked until this record exists, and the OOB " +
    "program (attack_script oob_interactsh) refuses to run unless oob_approved=true. " +
    "Capture: the authorization reference (ticket/contract/scope doc), in-scope targets, " +
    "explicit exclusions, rate limits, allowed test windows, the identity types allowed " +
    "(anonymous/user/admin/tenant roles), and whether out-of-band callbacks are approved. " +
    "Call again any time to update fields — omitted fields keep their previous values.",
  parameters: z.object({
    authorization_ref: z
      .string()
      .describe(
        "REQUIRED — the authorization reference: ticket id, contract/SOW number, or scope document identifier " +
          "that proves testing is permitted. Never invent one; ask the operator if unknown.",
      ),
    scope: z.array(z.string()).optional().describe("In-scope targets (domains, wildcards, CIDRs, app ids)."),
    exclusions: z.array(z.string()).optional().describe("Explicitly out-of-scope items / forbidden targets."),
    rate_limits: z.string().optional().describe("Rate limits to respect (e.g. '5 req/s, no brute force >100/min')."),
    test_windows: z.string().optional().describe("Allowed testing windows (e.g. 'business hours IST only', 'weekends')."),
    identity_types: z
      .array(z.string())
      .optional()
      .describe("Identity types allowed for testing (e.g. anonymous, user, admin, tenant-a, tenant-b)."),
    oob_approved: z
      .boolean()
      .optional()
      .describe("Whether out-of-band callbacks (interactsh/Collaborator) are approved for this engagement."),
    notes: z.string().optional().describe("Any other engagement constraints (destructive actions forbidden, data handling rules…)."),
  }),
  async execute(params, ctx) {
    const eng = Engagement.record({
      sessionID: Session.root(ctx.sessionID),
      authorizationRef: params.authorization_ref,
      scope: params.scope,
      exclusions: params.exclusions,
      rateLimits: params.rate_limits,
      testWindows: params.test_windows,
      identityTypes: params.identity_types,
      oobApproved: params.oob_approved,
      notes: params.notes,
    })
    return {
      title: `Engagement recorded: ${eng.authorizationRef}`,
      output: Engagement.formatForPrompt(eng.sessionID),
      metadata: { id: eng.id, oobApproved: eng.oobApproved, identities: eng.identityTypes.length },
    }
  },
})

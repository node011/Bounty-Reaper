import z from "zod"
import { Tool } from "./tool"
import { Chain } from "../methodology/chain"
import { Session } from "../session"

export const ChainProofTool = Tool.define("chain_proof", {
  description:
    "Record proof progress for a detected vulnerability chain (see methodology_status / chain opportunities). " +
    "A chain may only be marked CONFIRMED — and its severity elevated — when EVERY gate passes: " +
    "prerequisite (each finding independently confirmed), reachability (attacker can traverse A→B), " +
    "compatibility (tokens/roles/network/timing align), impact (final impact demonstrated with a minimal " +
    "safe proof), refutation (attempted to disprove). Until then the chain stays 'potential chain — unverified' " +
    "and severity must NOT be elevated. Call repeatedly as evidence accumulates; gates merge with prior state.",
  parameters: z.object({
    chain_id: z.string().describe("Chain id from methodology_status (shown as id=chn_...)"),
    prerequisite_ok: z.boolean().optional().describe("Each individual finding in the chain is independently confirmed."),
    reachability_ok: z.boolean().optional().describe("The attacker can actually traverse from finding A to finding B."),
    compatibility_ok: z
      .boolean()
      .optional()
      .describe("Tokens, roles, network paths and timing actually align across the hops."),
    impact_demonstrated: z
      .boolean()
      .optional()
      .describe("Final impact demonstrated with a minimal, safe proof (non-destructive, canary values)."),
    refutation_attempted: z
      .boolean()
      .optional()
      .describe("You actively tried to disprove the chain (controls, boundary checks, alternate explanations)."),
    hops: z
      .array(
        z.object({
          from: z.string().describe("Source hop (finding/entry or state)"),
          to: z.string().describe("Destination hop"),
          verified: z.boolean().describe("Whether this hop was actually verified"),
          evidence: z.string().optional().describe("Evidence: request id, response excerpt, artifact"),
        }),
      )
      .optional()
      .describe("Per-hop evidence trail."),
    notes: z.string().optional().describe("Anything else the reporter needs to know about the proof state."),
  }),
  async execute(params, ctx) {
    const { verdict, candidate } = Chain.recordProof(Session.root(ctx.sessionID), params.chain_id, {
      prerequisiteOk: params.prerequisite_ok,
      reachabilityOk: params.reachability_ok,
      compatibilityOk: params.compatibility_ok,
      impactDemonstrated: params.impact_demonstrated,
      refutationAttempted: params.refutation_attempted,
      hops: params.hops,
      notes: params.notes,
    })
    return {
      title: candidate
        ? `chain_proof: ${candidate.pattern} (${candidate.status})`
        : "chain_proof: not found",
      output: [
        verdict,
        candidate ? `\nChain: ${candidate.pattern} | status: ${candidate.status} | impact: ${candidate.expectedImpact}` : "",
        candidate ? `Entries: ${candidate.entryIDs.join(", ")} | Assets: ${candidate.assets.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { chainID: params.chain_id, status: candidate?.status ?? "not_found" },
    }
  },
})

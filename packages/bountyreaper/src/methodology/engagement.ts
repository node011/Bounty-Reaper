import { Database, eq } from "../storage/db"
import { EngagementTable } from "./methodology.sql"
import { Identifier } from "../id/id"

// ============================================================
// ENGAGEMENT — rules-of-engagement (ROE) preflight record
// ============================================================
//
// One record per session, captured via the `engagement_setup` tool BEFORE
// active testing. Records authorization reference, scope, exclusions, rate
// limits, test windows, allowed identity types and the OOB-callback approval
// flag. The methodology gate blocks active-testing phases until this exists
// (see Methodology.validateDeliverables + requiresEngagement on phases), and
// the OOB program (attack_script oob_interactsh) refuses when the engagement
// exists but oob_approved is false.

export namespace Engagement {
  export interface Info {
    id: string
    sessionID: string
    authorizationRef: string
    scope: string[]
    exclusions: string[]
    rateLimits?: string
    testWindows?: string
    identityTypes: string[]
    oobApproved: boolean
    notes?: string
    timeCreated: number
    timeUpdated: number
  }

  function rowToInfo(row: typeof EngagementTable.$inferSelect): Info {
    return {
      id: row.id,
      sessionID: row.session_id,
      authorizationRef: row.authorization_ref,
      scope: (row.scope as string[]) ?? [],
      exclusions: (row.exclusions as string[]) ?? [],
      rateLimits: row.rate_limits ?? undefined,
      testWindows: row.test_windows ?? undefined,
      identityTypes: (row.identity_types as string[]) ?? [],
      oobApproved: !!row.oob_approved,
      notes: row.notes ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
    }
  }

  /** Upsert the engagement record for this session. */
  export function record(input: {
    sessionID: string
    authorizationRef: string
    scope?: string[]
    exclusions?: string[]
    rateLimits?: string
    testWindows?: string
    identityTypes?: string[]
    oobApproved?: boolean
    notes?: string
  }): Info {
    const now = Date.now()
    return Database.use((db) => {
      const existing = db
        .select()
        .from(EngagementTable)
        .where(eq(EngagementTable.session_id, input.sessionID))
        .get()

      if (existing) {
        db.update(EngagementTable)
          .set({
            authorization_ref: input.authorizationRef,
            scope: (input.scope ?? (existing.scope as string[])) ?? [],
            exclusions: (input.exclusions ?? (existing.exclusions as string[])) ?? [],
            rate_limits: input.rateLimits ?? existing.rate_limits,
            test_windows: input.testWindows ?? existing.test_windows,
            identity_types: (input.identityTypes ?? (existing.identity_types as string[])) ?? [],
            oob_approved: input.oobApproved !== undefined ? (input.oobApproved ? 1 : 0) : existing.oob_approved,
            notes: input.notes ?? existing.notes,
            time_updated: now,
          })
          .where(eq(EngagementTable.id, existing.id))
          .run()
        const row = db.select().from(EngagementTable).where(eq(EngagementTable.id, existing.id)).get()!
        return rowToInfo(row)
      }

      const id = Identifier.ascending("engagement")
      db.insert(EngagementTable)
        .values({
          id,
          session_id: input.sessionID,
          authorization_ref: input.authorizationRef,
          scope: input.scope ?? [],
          exclusions: input.exclusions ?? [],
          rate_limits: input.rateLimits ?? null,
          test_windows: input.testWindows ?? null,
          identity_types: input.identityTypes ?? [],
          oob_approved: input.oobApproved ? 1 : 0,
          notes: input.notes ?? null,
          time_created: now,
          time_updated: now,
        })
        .run()
      const row = db.select().from(EngagementTable).where(eq(EngagementTable.id, id)).get()!
      return rowToInfo(row)
    })
  }

  export function get(sessionID: string): Info | undefined {
    const row = Database.use((db) =>
      db.select().from(EngagementTable).where(eq(EngagementTable.session_id, sessionID)).get(),
    )
    return row ? rowToInfo(row) : undefined
  }

  export function formatForPrompt(sessionID: string): string {
    const eng = get(sessionID)
    if (!eng) {
      return [
        "## Engagement (Rules of Engagement)",
        "",
        "NOT RECORDED — active-testing phases are blocked until `engagement_setup` is called.",
        "Capture: authorization reference, scope, exclusions, rate limits, test windows, identity types, OOB approval.",
      ].join("\n")
    }
    const lines = [
      "## Engagement (Rules of Engagement)",
      "",
      `- Authorization: ${eng.authorizationRef}`,
      `- Scope: ${eng.scope.length > 0 ? eng.scope.join(", ") : "(not set)"}`,
      `- Exclusions: ${eng.exclusions.length > 0 ? eng.exclusions.join(", ") : "(none)"}`,
      `- Rate limits: ${eng.rateLimits ?? "(not set)"}`,
      `- Test windows: ${eng.testWindows ?? "(not set)"}`,
      `- Identity types: ${eng.identityTypes.length > 0 ? eng.identityTypes.join(", ") : "(not set)"}`,
      `- OOB callbacks approved: ${eng.oobApproved ? "YES" : "NO"}`,
    ]
    if (eng.notes) lines.push(`- Notes: ${eng.notes}`)
    return lines.join("\n")
  }
}

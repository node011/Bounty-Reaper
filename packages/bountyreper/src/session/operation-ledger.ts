import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Database, eq } from "../storage/db"
import { Identifier } from "../id/id"

export const OperationLedgerTable = sqliteTable("operation_ledger", {
  id: text().primaryKey(),
  session_id: text().notNull(),
  type: text().notNull(), // fact | relation | evidence | replay | finding
  data: text().notNull(), // JSON
  time_created: integer().notNull(),
})

export namespace OperationLedger {
  export type Entry = {
    id: string
    type: "fact" | "relation" | "evidence" | "replay" | "finding"
    data: Record<string, unknown>
    time: number
  }

  export function add(sessionID: string, type: Entry["type"], data: Record<string, unknown>): Entry {
    const id = Identifier.ascending("operation_ledger")
    const now = Date.now()
    Database.use((db) => {
      db.insert(OperationLedgerTable).values({
        id,
        session_id: sessionID,
        type,
        data: JSON.stringify(data),
        time_created: now,
      }).run()
    })
    return { id, type, data, time: now }
  }

  export function get(sessionID: string): Entry[] {
    const rows = Database.use((db) =>
      db.select().from(OperationLedgerTable).where(eq(OperationLedgerTable.session_id, sessionID)).all()
    )
    return rows.map((r) => ({
      id: r.id,
      type: r.type as Entry["type"],
      data: JSON.parse(r.data),
      time: r.time_created,
    }))
  }

  export function exportBundle(sessionID: string): string {
    const entries = get(sessionID)
    return JSON.stringify({ sessionID, entries, exportedAt: Date.now() }, null, 2)
  }
}

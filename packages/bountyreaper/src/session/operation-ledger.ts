import { Database, eq, asc } from "../storage/db"
import { OperationLedgerTable } from "./operation-ledger.sql"
import { Identifier } from "../id/id"

export namespace OperationLedger {
  export type EntryType = "fact" | "relation" | "evidence" | "replay" | "finding"

  export type Entry = {
    id: string
    type: EntryType
    data: Record<string, unknown>
    time: number
  }

  export function add(sessionID: string, type: EntryType, data: Record<string, unknown>): Entry {
    const id = Identifier.ascending("operation_ledger")
    const now = Date.now()
    Database.use((db) => {
      db.insert(OperationLedgerTable)
        .values({ id, session_id: sessionID, type, data: JSON.stringify(data), time_created: now })
        .run()
    })
    return { id, type, data, time: now }
  }

  export function get(sessionID: string): Entry[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(OperationLedgerTable)
        .where(eq(OperationLedgerTable.session_id, sessionID))
        .orderBy(asc(OperationLedgerTable.time_created))
        .all(),
    )
    return rows.map((r) => ({ id: r.id, type: r.type as EntryType, data: JSON.parse(r.data), time: r.time_created }))
  }

  /** Export the operation as a portable bundle (share/resume/handoff). */
  export function exportBundle(sessionID: string): string {
    return JSON.stringify(
      { sessionID, exportedAt: Date.now(), entries: get(sessionID) },
      null,
      2,
    )
  }
}

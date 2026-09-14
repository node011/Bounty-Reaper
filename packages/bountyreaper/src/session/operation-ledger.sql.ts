import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import { SessionTable } from "./session.sql"

export const OperationLedgerTable = sqliteTable(
  "operation_ledger",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().notNull(), // fact | relation | evidence | replay | finding
    data: text().notNull(), // JSON payload
    ...Timestamps,
  },
  (t) => [index("operation_ledger_session_idx").on(t.session_id), index("operation_ledger_type_idx").on(t.type)],
)

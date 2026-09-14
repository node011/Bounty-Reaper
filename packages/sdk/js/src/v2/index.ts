export * from "./client.js"
export * from "./server.js"

import { createBountyReaperClient } from "./client.js"
import { createBountyReaperServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createBountyReaper(options?: ServerOptions) {
  const server = await createBountyReaperServer({
    ...options,
  })

  const client = createBountyReaperClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

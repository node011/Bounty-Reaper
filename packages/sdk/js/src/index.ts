export * from "./client.js"
export * from "./server.js"

import { createBountyreperClient } from "./client.js"
import { createBountyreperServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createBountyreper(options?: ServerOptions) {
  const server = await createBountyreperServer({
    ...options,
  })

  const client = createBountyreperClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

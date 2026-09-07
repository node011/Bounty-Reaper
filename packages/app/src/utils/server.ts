import { createBountyreperClient } from "@bountyreper-io/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

export function basicAuth(username: string, password: string): string {
  const credentials = `${username}:${password}`
  const bytes = new TextEncoder().encode(credentials)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createBountyreperClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: basicAuth(server.username ?? "bountyreper", server.password),
    }
  })()

  return createBountyreperClient({
    ...config,
    headers: { ...config.headers, ...auth },
    baseUrl: server.url,
  })
}

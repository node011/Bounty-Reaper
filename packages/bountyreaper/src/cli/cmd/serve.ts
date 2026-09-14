import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless bountyreaper server",
  handler: async (args) => {
    if (!Flag.BOUNTYREAPER_SERVER_PASSWORD) {
      console.error(
        "Error: BOUNTYREAPER_SERVER_PASSWORD is required.\nSet it with: export BOUNTYREAPER_SERVER_PASSWORD=yourpassword",
      )
      process.exit(1)
    }
    const opts = await resolveNetworkOptions(args)
    const server = Server.listen({ ...opts, webUI: false })
    console.log(`bountyreaper server listening on http://${server.hostname}:${server.port}`)
    console.log(`API-only mode — connect from app.bountyreper.io or use 'bountyreaper web' for built-in UI`)
    await new Promise(() => {})
    await server.stop()
  },
})

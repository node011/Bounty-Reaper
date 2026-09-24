import { EOL } from "os"
import { Config } from "../../../config/config"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"
import { redactConfig } from "./redact"

export const ConfigCommand = cmd({
  command: "config",
  describe: "show resolved configuration",
  builder: (yargs) => yargs,
  async handler() {
    await bootstrap(process.cwd(), async () => {
      const config = redactConfig(Config.redactSecrets(await Config.get()))
      process.stdout.write(JSON.stringify(config, null, 2) + EOL)
    })
  },
})

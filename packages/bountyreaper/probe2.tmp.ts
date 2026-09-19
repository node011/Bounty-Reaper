import { generateText } from "ai"
import { BUNDLED_PROVIDERS } from "./src/provider/bundled-providers.ts"
const factory = (BUNDLED_PROVIDERS as any)["@ai-sdk/openai"]
const sdk = factory({ apiKey: "sk-ys3TYFeplaceholder", baseURL: "https://opencode.ai/zen/v1" })
console.log("sdk built")
